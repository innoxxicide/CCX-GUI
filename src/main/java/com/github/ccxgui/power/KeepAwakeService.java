package com.github.ccxgui.power;

import com.github.ccxgui.settings.CodemossSettingsService;
import com.github.ccxgui.settings.KeepAwakeSettings;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * Application-wide owner of the "don't let this machine sleep while an agent is
 * working" state, gated by {@link KeepAwakeSettings} (default off).
 *
 * <h3>Why holders instead of a counter</h3>
 * Callers register a token and drop it again. Tokens are compared by identity in
 * a set, so a repeated acquire or a double release is idempotent — a plain
 * counter would drift on the busy-flag paths, which legitimately report the same
 * transition more than once, and a drifted counter here means either a machine
 * that never sleeps or one that sleeps mid-turn.
 *
 * <h3>Why a grace period</h3>
 * The inhibitor is not dropped the instant the last holder leaves. Work arrives
 * in bursts — turn to turn, and (the case this feature exists for) the gap
 * between a turn failing on a usage limit and the auto-resume controller
 * confirming that a restart is scheduled. Releasing eagerly and re-acquiring
 * seconds later would be pure churn, and the delay costs nothing against OS idle
 * timeouts measured in minutes. Flipping the setting <em>off</em> bypasses the
 * grace and releases immediately, because that is an explicit user instruction.
 *
 * <h3>Threading</h3>
 * Holder bookkeeping is guarded by {@link #lock}; every OS-facing call runs on
 * {@link #worker}, a single thread. That is required by
 * {@link WindowsSleepInhibitor} (execution state is per-thread) and conveniently
 * confines {@link #engaged} and {@link #pendingRelease} to one thread as well.
 */
public final class KeepAwakeService {

    private static final Logger LOG = Logger.getInstance(KeepAwakeService.class);

    /** Delay between the last holder leaving and the OS inhibitor actually dropping. */
    static final long DEFAULT_RELEASE_GRACE_MS = 30_000L;

    private static volatile KeepAwakeService instance;

    private final SleepInhibitor inhibitor;
    private final ScheduledExecutorService worker;
    private final long releaseGraceMs;
    private final BooleanSupplier settingsReader;

    private final Object lock = new Object();
    private final Set<Object> holders = Collections.newSetFromMap(new IdentityHashMap<>());
    private boolean enabled;
    private boolean enabledLoaded;

    /** Worker-thread confined. Volatile only so tests can observe it. */
    private volatile boolean engaged;
    private ScheduledFuture<?> pendingRelease;

    public static KeepAwakeService getInstance() {
        KeepAwakeService local = instance;
        if (local == null) {
            synchronized (KeepAwakeService.class) {
                local = instance;
                if (local == null) {
                    local = new KeepAwakeService(
                            SleepInhibitors.forCurrentPlatform(),
                            Executors.newSingleThreadScheduledExecutor(runnable -> {
                                Thread thread = new Thread(runnable, "CCX-GUI keep-awake");
                                thread.setDaemon(true);
                                return thread;
                            }),
                            DEFAULT_RELEASE_GRACE_MS,
                            KeepAwakeService::readEnabledFromSettings);
                    local.registerShutdownHook();
                    instance = local;
                }
            }
        }
        return local;
    }

    KeepAwakeService(SleepInhibitor inhibitor, ScheduledExecutorService worker,
                     long releaseGraceMs, BooleanSupplier settingsReader) {
        this.inhibitor = inhibitor;
        this.worker = worker;
        this.releaseGraceMs = releaseGraceMs;
        this.settingsReader = settingsReader;
    }

    /**
     * Register {@code token} as a reason to stay awake. Safe to call repeatedly
     * with the same token.
     *
     * @param reason short label for the IDE log, e.g. {@code "agent busy"}
     */
    public void acquire(Object token, String reason) {
        if (token == null) {
            return;
        }
        boolean added;
        synchronized (lock) {
            added = holders.add(token);
        }
        if (added) {
            LOG.debug("[KeepAwake] Hold acquired: " + reason);
            refresh(false);
        }
    }

    /** Drop {@code token}. Safe to call for a token that is not held. */
    public void release(Object token) {
        if (token == null) {
            return;
        }
        boolean removed;
        synchronized (lock) {
            removed = holders.remove(token);
        }
        if (removed) {
            refresh(false);
        }
    }

    /**
     * Apply a settings change. Turning the feature off releases immediately;
     * turning it on re-applies whatever holds are currently outstanding, so
     * enabling it mid-turn takes effect without waiting for the next turn.
     */
    public void setEnabled(boolean value) {
        synchronized (lock) {
            enabled = value;
            enabledLoaded = true;
        }
        refresh(!value);
    }

    /** Release everything and stop the worker. Called on IDE shutdown. */
    public void shutdown() {
        submit(() -> {
            cancelPendingRelease();
            releaseNow();
        });
        worker.shutdown();
    }

    /** Whether the OS inhibitor is currently held. */
    boolean isInhibiting() {
        return engaged;
    }

    int holderCount() {
        synchronized (lock) {
            return holders.size();
        }
    }

    // ---- Worker-thread state machine ---------------------------------------

    private void refresh(boolean immediate) {
        submit(() -> applyDesiredState(immediate));
    }

    private void applyDesiredState(boolean immediate) {
        if (isWanted()) {
            cancelPendingRelease();
            if (!engaged) {
                inhibitor.engage();
                engaged = true;
                LOG.info("[KeepAwake] Sleep inhibited via " + inhibitor.describe());
            }
            return;
        }
        if (!engaged) {
            return;
        }
        if (immediate) {
            cancelPendingRelease();
            releaseNow();
            return;
        }
        if (pendingRelease != null) {
            return;
        }
        pendingRelease = worker.schedule(() -> {
            pendingRelease = null;
            // Re-check: a new turn (or an armed auto-resume) may have taken a hold
            // while the grace period was running.
            if (!isWanted()) {
                releaseNow();
            }
        }, releaseGraceMs, TimeUnit.MILLISECONDS);
    }

    private void releaseNow() {
        if (!engaged) {
            return;
        }
        inhibitor.disengage();
        engaged = false;
        LOG.info("[KeepAwake] Sleep allowed again.");
    }

    private void cancelPendingRelease() {
        if (pendingRelease != null) {
            pendingRelease.cancel(false);
            pendingRelease = null;
        }
    }

    private boolean isWanted() {
        synchronized (lock) {
            if (holders.isEmpty()) {
                return false;
            }
            if (enabledLoaded) {
                return enabled;
            }
        }
        // First read of the setting. Deliberately off the caller's thread (this
        // runs on the worker) because it hits disk.
        boolean loaded = settingsReader.getAsBoolean();
        synchronized (lock) {
            if (!enabledLoaded) {
                enabled = loaded;
                enabledLoaded = true;
            }
            return enabled && !holders.isEmpty();
        }
    }

    /**
     * Every worker task is wrapped so a failure cannot escape. Beyond the usual
     * "don't lose the log line", this protects the Windows backend: an execution
     * state belongs to the thread that set it, so a worker thread torn down by an
     * escaping error would silently un-inhibit sleep.
     */
    private void submit(Runnable task) {
        try {
            worker.execute(() -> {
                try {
                    task.run();
                } catch (Throwable t) {
                    LOG.warn("[KeepAwake] Worker task failed: " + t.getMessage(), t);
                }
            });
        } catch (RejectedExecutionException e) {
            LOG.debug("[KeepAwake] Worker already shut down; ignoring state change.");
        }
    }

    /**
     * Last-resort cleanup for the child-process backends. The Windows request
     * dies with the process on its own, and both Unix helpers self-terminate when
     * the IDE disappears — this simply makes a graceful exit tidy rather than
     * relying on those guards.
     */
    private void registerShutdownHook() {
        try {
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try {
                    inhibitor.disengage();
                } catch (Throwable ignored) {
                    // Nothing useful to do while the JVM is going down.
                }
            }, "CCX-GUI keep-awake shutdown"));
        } catch (IllegalStateException e) {
            LOG.debug("[KeepAwake] JVM already shutting down; skipping cleanup hook.");
        }
    }

    private static boolean readEnabledFromSettings() {
        try {
            return new CodemossSettingsService().getKeepAwakeEnabled();
        } catch (Exception e) {
            LOG.warn("[KeepAwake] Could not read the keep-awake setting: " + e.getMessage());
            return KeepAwakeSettings.DEFAULT_KEEP_AWAKE_ENABLED;
        }
    }
}
