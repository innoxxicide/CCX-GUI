package com.github.ccxgui.provider.claude;

import com.github.ccxgui.provider.claude.ClaudeUsageLimitClassifier.Assessment;
import com.github.ccxgui.settings.ClaudeAutoResumeSettings;
import com.github.ccxgui.settings.CodemossSettingsService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Per-window controller that resumes a Claude session automatically once the
 * account's usage limit resets.
 *
 * <p>Lifecycle, in one sentence: a turn ends in an error → we fetch fresh usage
 * data → if a rate-limit window is exhausted we <em>arm</em> (schedule a wake for
 * just after the latest reset) → at wake we re-fetch and only <em>resume</em>
 * (send the configured prompt) once the block has verifiably lifted.
 *
 * <p>The controller is Claude-only and gated by the account-global
 * {@link ClaudeAutoResumeSettings} toggle (default off); when the toggle is off
 * it is completely inert. It owns no UI and no persistence directly — those are
 * delegated to a {@link Host} the window supplies, which keeps this class
 * testable and free of a {@code ui} → {@code provider} layering dependency.
 *
 * <h3>Verify-before-send</h3>
 * The usage endpoint can lag enforcement, so detection is deliberately tolerant
 * ({@link ClaudeUsageLimitClassifier#EXHAUSTED_UTILIZATION}) while the wake-time
 * check is strict: we only send when the previously-exhausted windows have
 * dropped below {@link ClaudeUsageLimitClassifier#CLEARED_UTILIZATION}. If they
 * have not, we reschedule up to {@link #MAX_RETRIES} times before handing off to
 * a manual "limit reset — continue?" prompt.
 *
 * <h3>Restart</h3>
 * On IDE restart the persisted wake time is replayed through
 * {@link #restoreFromPersisted(long)}: still-future wakes are re-armed; a wake
 * whose reset passed within {@link #RESTART_FRESHNESS_WINDOW_MS} fires an
 * immediate verify-then-resume; anything older is left for manual resume so
 * long-abandoned work never auto-starts. Tab close disposes the controller and
 * the tab's persisted wake with it, killing the feature for that session.
 */
public final class ClaudeAutoResumeController {

    private static final Logger LOG = Logger.getInstance(ClaudeAutoResumeController.class);

    /** Padding added after a window's {@code resets_at} before we retry, to stay clear of the exact boundary. */
    static final long WAKE_BUFFER_MS = 90_000L;
    /** Delay before re-checking when a wake fired but the block had not yet lifted. */
    static final long RETRY_DELAY_MS = 240_000L;
    /** How many times a wake may find the block still active before we fall back to manual resume. */
    static final int MAX_RETRIES = 5;
    /** On restart, a reset that passed within this window auto-resumes; older waits for a manual click. */
    static final long RESTART_FRESHNESS_WINDOW_MS = 30L * 60_000L;

    /**
     * The window's collaboration surface: session access, liveness, persistence,
     * and UI notifications. All methods may be called off the EDT; the
     * implementation marshals to the EDT where its own APIs require it.
     */
    public interface Host {
        /** Current session provider (e.g. {@code "claude"}), or {@code null} before binding. */
        String provider();

        /** {@code false} once the window is disposed; stops all scheduled work. */
        boolean isActive();

        /**
         * A wake is now scheduled. {@code wakeAtMs} is the raw latest reset time
         * (0 when unknown) and should be persisted so the wake survives restart;
         * {@code exhaustedWindows} is for display only.
         */
        void onArmed(long wakeAtMs, Set<String> exhaustedWindows);

        /**
         * The block has lifted: send {@code prompt} to the session as a user
         * message to resume the work. Called after the controller has already
         * disarmed, so the persisted wake is cleared by the time this runs.
         */
        void resume(String prompt);

        /**
         * Auto-resume gave up (retries exhausted, or a restart wake was too stale):
         * surface a passive "limit reset — continue?" prompt and clear the persisted wake.
         */
        void onManualResumeNeeded(long wakeAtMs);

        /** No wake is armed anymore; clear any pending indicator and the persisted wake. */
        void onDisarmed();
    }

    private final Host host;
    private final CodemossSettingsService settings;
    private final ScheduledExecutorService scheduler;
    /** Bypasses the display cache/throttle to read usage taken after the limit error. Injectable for tests. */
    private final Supplier<CompletableFuture<String>> usageFetcher;

    private final Object lock = new Object();
    private final AtomicInteger retryCount = new AtomicInteger(0);

    private volatile boolean disposed = false;
    private ScheduledFuture<?> scheduledWake;
    /** Raw latest reset time of the exhausted windows (0 when unknown); persisted by the host. */
    private volatile long wakeAtMs = 0L;
    private volatile boolean armed = false;
    private volatile Set<String> exhaustedWindows = Collections.emptySet();

    public ClaudeAutoResumeController(Host host, CodemossSettingsService settings) {
        this(host, settings, AppExecutorUtil.getAppScheduledExecutorService(),
                ClaudeUsageLimitsService::fetchFreshForLimitCheck);
    }

    ClaudeAutoResumeController(Host host, CodemossSettingsService settings,
                              ScheduledExecutorService scheduler,
                              Supplier<CompletableFuture<String>> usageFetcher) {
        this.host = host;
        this.settings = settings;
        this.scheduler = scheduler;
        this.usageFetcher = usageFetcher;
    }

    /** Whether a wake is currently scheduled. */
    public boolean isArmed() {
        return armed;
    }

    /** The raw latest reset time backing the current wake, or {@code 0} when none. */
    public long getWakeAtMs() {
        return wakeAtMs;
    }

    /**
     * Entry point wired from the window's session callback: a Claude turn ended
     * in an error. Ignored unless the feature is enabled for a Claude session and
     * no wake is already armed. Fetches fresh usage data (bypassing the display
     * cache/throttle) and arms only if a rate-limit window is actually exhausted.
     */
    public void onTurnError(String error) {
        if (disposed || armed || !isEnabledForClaude()) {
            return;
        }
        usageFetcher.get().thenAccept(json -> {
            if (disposed || armed) {
                return;
            }
            Assessment assessment = ClaudeUsageLimitClassifier.assess(json);
            if (!assessment.isLimitHit()) {
                // The turn failed for some other reason; not our concern.
                return;
            }
            arm(assessment.getWakeAtMs(), assessment.getExhaustedWindows());
        }).exceptionally(ex -> {
            LOG.warn("[ClaudeAutoResume] Limit-check fetch failed: " + ex.getMessage());
            return null;
        });
    }

    /**
     * Replay a persisted wake after restart. Applies the freshness policy: future
     * wakes are re-armed, recently-passed wakes verify-then-resume immediately,
     * and long-passed wakes defer to manual resume.
     */
    public void restoreFromPersisted(long persistedWakeAtMs) {
        if (disposed || persistedWakeAtMs <= 0 || armed || !isEnabledForClaude()) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now < persistedWakeAtMs) {
            // Reset still in the future: re-arm exactly as if we had just detected it.
            // The exhausted-window set was not persisted, so wake-time verification
            // falls back to re-assessment (assess) rather than the stricter
            // per-window hysteresis — acceptable for the restart path.
            armInternal(persistedWakeAtMs, Collections.emptySet(), persistedWakeAtMs + WAKE_BUFFER_MS);
            return;
        }
        long age = now - persistedWakeAtMs;
        if (age <= RESTART_FRESHNESS_WINDOW_MS) {
            // Reset passed recently: fire an immediate verify-then-resume.
            armInternal(persistedWakeAtMs, Collections.emptySet(), now);
        } else {
            // Too stale to auto-start work the user may have walked away from.
            host.onManualResumeNeeded(persistedWakeAtMs);
        }
    }

    /**
     * User explicitly asked to resume from the "limit reset — continue?" prompt
     * (or the armed indicator). Cancels any pending wake, clears the indicator,
     * and sends the resume prompt immediately without re-verifying usage — the
     * click is an explicit override, so we trust the user's intent even if the
     * endpoint still lags. No-op once disposed.
     */
    public void manualResume() {
        if (disposed) {
            return;
        }
        sendResume();
    }

    /**
     * Stop all scheduled work. Called from window dispose (tab close or IDE
     * shutdown). Deliberately does not touch persisted state: on tab close the
     * host removes the tab's state anyway, while on shutdown the persisted wake
     * must survive for {@link #restoreFromPersisted(long)} to replay it.
     */
    public void dispose() {
        synchronized (lock) {
            disposed = true;
            armed = false;
            cancelScheduledLocked();
        }
    }

    private void arm(long resetAtMs, Set<String> windows) {
        armInternal(resetAtMs, windows, computeFireAt(resetAtMs));
    }

    private void armInternal(long resetAtMs, Set<String> windows, long fireAtMs) {
        synchronized (lock) {
            if (disposed) {
                return;
            }
            this.wakeAtMs = resetAtMs;
            this.exhaustedWindows = windows.isEmpty()
                    ? Collections.emptySet()
                    : Collections.unmodifiableSet(new LinkedHashSet<>(windows));
            this.armed = true;
            this.retryCount.set(0);
            scheduleFireAtLocked(fireAtMs);
        }
        host.onArmed(resetAtMs, exhaustedWindows);
        LOG.info("[ClaudeAutoResume] Armed: resetAt=" + resetAtMs + ", windows=" + exhaustedWindows
                + ", fireInMs=" + Math.max(0, fireAtMs - System.currentTimeMillis()));
    }

    private long computeFireAt(long resetAtMs) {
        long now = System.currentTimeMillis();
        if (resetAtMs <= 0) {
            // Unknown reset time: poll on the retry cadence until the block clears.
            return now + RETRY_DELAY_MS;
        }
        return Math.max(resetAtMs + WAKE_BUFFER_MS, now + WAKE_BUFFER_MS);
    }

    private void scheduleFireAtLocked(long fireAtMs) {
        cancelScheduledLocked();
        long delay = Math.max(0, fireAtMs - System.currentTimeMillis());
        scheduledWake = scheduler.schedule(this::onWakeFire, delay, TimeUnit.MILLISECONDS);
    }

    private void cancelScheduledLocked() {
        if (scheduledWake != null) {
            scheduledWake.cancel(false);
            scheduledWake = null;
        }
    }

    private void onWakeFire() {
        if (disposed || !armed) {
            return;
        }
        if (!host.isActive()) {
            dispose();
            return;
        }
        usageFetcher.get().thenAccept(json -> {
            if (disposed || !armed) {
                return;
            }
            Assessment assessment = ClaudeUsageLimitClassifier.assess(json);
            boolean stillBlocked = assessment.isLimitHit()
                    || !ClaudeUsageLimitClassifier.allWindowsCleared(json, exhaustedWindows);
            if (stillBlocked) {
                reschedule(assessment);
            } else {
                sendResume();
            }
        }).exceptionally(ex -> {
            LOG.warn("[ClaudeAutoResume] Wake-time fetch failed: " + ex.getMessage());
            reschedule(null);
            return null;
        });
    }

    private void reschedule(Assessment assessment) {
        long deferredWakeAt = wakeAtMs;
        int attempt = retryCount.incrementAndGet();
        if (attempt > MAX_RETRIES) {
            LOG.info("[ClaudeAutoResume] Block still active after " + MAX_RETRIES
                    + " retries; deferring to manual resume.");
            disarm();
            host.onManualResumeNeeded(deferredWakeAt);
            return;
        }
        long now = System.currentTimeMillis();
        long nextFireAt = (assessment != null && assessment.isLimitHit() && assessment.getWakeAtMs() > now)
                ? assessment.getWakeAtMs() + WAKE_BUFFER_MS
                : now + RETRY_DELAY_MS;
        synchronized (lock) {
            if (disposed || !armed) {
                return;
            }
            scheduleFireAtLocked(nextFireAt);
        }
        LOG.info("[ClaudeAutoResume] Block still active (attempt " + attempt + "/" + MAX_RETRIES
                + "); rechecking in " + Math.max(0, nextFireAt - now) + "ms.");
    }

    private void sendResume() {
        String prompt = resolvePrompt();
        disarm();
        try {
            host.resume(prompt);
            LOG.info("[ClaudeAutoResume] Sent resume prompt after usage-limit reset.");
        } catch (Exception e) {
            LOG.warn("[ClaudeAutoResume] Resume send threw: " + e.getMessage());
        }
    }

    private void disarm() {
        synchronized (lock) {
            armed = false;
            wakeAtMs = 0L;
            exhaustedWindows = Collections.emptySet();
            retryCount.set(0);
            cancelScheduledLocked();
        }
        host.onDisarmed();
    }

    private boolean isEnabledForClaude() {
        if (!"claude".equalsIgnoreCase(host.provider())) {
            return false;
        }
        try {
            return settings.getClaudeAutoResumeEnabled();
        } catch (IOException e) {
            LOG.warn("[ClaudeAutoResume] Could not read enabled flag: " + e.getMessage());
            return false;
        }
    }

    private String resolvePrompt() {
        try {
            String prompt = settings.getClaudeAutoResumePrompt();
            if (prompt != null && !prompt.isBlank()) {
                return prompt;
            }
        } catch (IOException e) {
            LOG.warn("[ClaudeAutoResume] Could not read resume prompt: " + e.getMessage());
        }
        return ClaudeAutoResumeSettings.DEFAULT_CLAUDE_AUTO_RESUME_PROMPT;
    }
}
