package com.github.ccxgui.schedule;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Per-window controller for "Send scheduled": the user picks a date and time and
 * the message currently in the input box is delivered then instead of now.
 *
 * <p>It is the user-driven twin of
 * {@code com.github.ccxgui.provider.claude.ClaudeAutoResumeController} and
 * deliberately reuses its shape — a {@link Host} SPI so the controller owns no UI
 * and no persistence, a single {@link ScheduledFuture} guarded by a lock, a
 * restart replay with a freshness window, and a bounded retry that falls back to
 * a manual prompt rather than silently dropping the work. The differences are
 * that the fire time and the text come from the user rather than from a usage
 * classifier, and that nothing here is Claude-specific: a scheduled send works
 * for whichever provider the session is bound to when it fires.
 *
 * <h3>Rules</h3>
 * <ul>
 *   <li>The message must be non-blank and at most {@link #MAX_MESSAGE_LENGTH}
 *       characters — the same ceiling the auto-resume prompt uses, since the text
 *       rides the same per-tab persisted state.</li>
 *   <li>The target time must be in the future and no more than
 *       {@link #MAX_LEAD_MS} ahead.</li>
 *   <li>One schedule per tab. Scheduling again replaces the pending one, which is
 *       what a user re-picking a time means.</li>
 * </ul>
 *
 * <h3>Busy at fire time</h3>
 * Unlike auto-resume — which only ever arms after a turn has already failed — a
 * scheduled send can come due while a turn is still streaming. Sending into that
 * would interleave with the running turn, so the fire is deferred by
 * {@link #BUSY_RETRY_DELAY_MS} and retried up to {@link #MAX_BUSY_RETRIES} times;
 * if the session is still busy after that the message is handed to the host as
 * missed, so the user can send it with one click instead of losing it.
 *
 * <h3>Restart</h3>
 * The pending time and text are persisted per tab and replayed through
 * {@link #restoreFromPersisted(long, String)}: a still-future time is re-armed, a
 * time that passed within {@link #RESTART_FRESHNESS_WINDOW_MS} fires immediately,
 * and anything older is reported missed rather than firing into a session the
 * user may have walked away from hours ago.
 */
public final class ScheduledSendController {

    private static final Logger LOG = Logger.getInstance(ScheduledSendController.class);

    /** Longest a send may be scheduled ahead; matches the longest usage-limit window the auto-resume path ever waits out. */
    public static final long MAX_LEAD_MS = 7L * 24 * 60 * 60 * 1000;
    /** Ceiling on the scheduled text, mirroring the auto-resume prompt cap — both ride the same per-tab persisted state. */
    public static final int MAX_MESSAGE_LENGTH = 10_000;
    /** On restart, a target that passed within this window still fires; older is reported missed. */
    static final long RESTART_FRESHNESS_WINDOW_MS = 30L * 60_000L;
    /** How long to wait before re-checking when the session was mid-turn at fire time. */
    static final long BUSY_RETRY_DELAY_MS = 30_000L;
    /** How many busy deferrals to allow (10 minutes at the delay above) before handing off to the user. */
    static final int MAX_BUSY_RETRIES = 20;

    /** Outcome of a {@link #schedule(String, long)} request; anything but {@link #SCHEDULED} left the state untouched. */
    public enum Result {
        SCHEDULED,
        EMPTY_MESSAGE,
        MESSAGE_TOO_LONG,
        TIME_IN_PAST,
        TOO_FAR_AHEAD
    }

    /**
     * The window's collaboration surface: liveness, turn state, persistence and UI
     * notifications. Every method may be called off the EDT — the fire path runs on
     * a pooled scheduler thread — so implementations marshal where their own APIs
     * require it.
     */
    public interface Host {
        /** {@code false} once the window is disposed; stops all scheduled work. */
        boolean isActive();

        /** Whether a turn is currently in flight, in which case the fire is deferred. */
        boolean isBusy();

        /** A send is now scheduled for {@code fireAtMs}; persist it and show the pending indicator. */
        void onArmed(long fireAtMs, String message);

        /**
         * The scheduled time arrived: deliver {@code message} as a user message.
         * Called after the controller has already disarmed, so the persisted
         * schedule is cleared by the time this runs.
         */
        void send(String message);

        /**
         * The send could not be delivered on time (the session stayed busy, or the
         * target was already stale on restart). Surface it for a one-click manual
         * send instead of dropping the text.
         */
        void onMissed(long fireAtMs, String message);

        /** Nothing is scheduled anymore; clear the indicator and the persisted schedule. */
        void onDisarmed();
    }

    private final Host host;
    private final ScheduledExecutorService scheduler;

    private final Object lock = new Object();
    private final AtomicInteger busyRetryCount = new AtomicInteger(0);

    private volatile boolean disposed = false;
    private ScheduledFuture<?> scheduledSend;
    /** Target epoch millis of the pending send, or {@code 0} when none; persisted by the host. */
    private volatile long fireAtMs = 0L;
    /** Text of the pending send, or {@code null} when none; persisted by the host. */
    private volatile String message = null;
    private volatile boolean armed = false;

    public ScheduledSendController(Host host) {
        this(host, AppExecutorUtil.getAppScheduledExecutorService());
    }

    ScheduledSendController(Host host, ScheduledExecutorService scheduler) {
        this.host = host;
        this.scheduler = scheduler;
    }

    /** Whether a send is currently scheduled. */
    public boolean isArmed() {
        return armed;
    }

    /** Target time of the pending send, or {@code 0} when none is scheduled. */
    public long getFireAtMs() {
        return fireAtMs;
    }

    /** Text of the pending send, or {@code null} when none is scheduled. */
    public String getMessage() {
        return message;
    }

    /**
     * Schedule {@code rawMessage} for delivery at {@code targetAtMs}, replacing any
     * pending schedule. Returns the validation outcome so the caller can report a
     * precise reason to the webview; only {@link Result#SCHEDULED} changes state.
     */
    public Result schedule(String rawMessage, long targetAtMs) {
        if (disposed) {
            return Result.EMPTY_MESSAGE;
        }
        String normalized = rawMessage != null ? rawMessage.trim() : "";
        if (normalized.isEmpty()) {
            return Result.EMPTY_MESSAGE;
        }
        if (normalized.length() > MAX_MESSAGE_LENGTH) {
            return Result.MESSAGE_TOO_LONG;
        }
        long now = System.currentTimeMillis();
        if (targetAtMs <= now) {
            return Result.TIME_IN_PAST;
        }
        if (targetAtMs - now > MAX_LEAD_MS) {
            return Result.TOO_FAR_AHEAD;
        }
        armInternal(targetAtMs, normalized, targetAtMs);
        return Result.SCHEDULED;
    }

    /**
     * Replay a persisted schedule after restart. Future targets are re-armed, a
     * target that passed within {@link #RESTART_FRESHNESS_WINDOW_MS} fires
     * immediately, and anything older is reported missed.
     */
    public void restoreFromPersisted(long persistedFireAtMs, String persistedMessage) {
        if (disposed || armed || persistedFireAtMs <= 0) {
            return;
        }
        String normalized = persistedMessage != null ? persistedMessage.trim() : "";
        if (normalized.isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now < persistedFireAtMs) {
            armInternal(persistedFireAtMs, normalized, persistedFireAtMs);
            return;
        }
        if (now - persistedFireAtMs <= RESTART_FRESHNESS_WINDOW_MS) {
            // Just missed it — the IDE was restarting across the deadline.
            armInternal(persistedFireAtMs, normalized, now);
        } else {
            // Too stale to start work the user may have walked away from.
            host.onMissed(persistedFireAtMs, normalized);
        }
    }

    /**
     * User cancelled the pending send. The text is not returned to the input box —
     * the webview keeps its own draft — so this simply drops the schedule.
     */
    public void cancel() {
        if (disposed || !armed) {
            return;
        }
        LOG.info("[ScheduledSend] Cancelled a send scheduled for " + fireAtMs);
        disarm();
    }

    /**
     * User asked to send the pending (or missed) message now. Skips the busy check:
     * the click is an explicit override, and the frontend queues a message sent
     * mid-turn the same way it queues one typed by hand.
     */
    public void sendNow(String fallbackMessage) {
        if (disposed) {
            return;
        }
        String pending = message;
        String text = (pending != null && !pending.isBlank()) ? pending : fallbackMessage;
        if (text == null || text.isBlank()) {
            disarm();
            return;
        }
        deliver(text.trim());
    }

    /**
     * Stop the scheduled send. Called from window dispose (tab close or IDE
     * shutdown). Deliberately does not touch persisted state: on tab close the host
     * removes the tab's state anyway, while on shutdown the persisted schedule must
     * survive for {@link #restoreFromPersisted} to replay it.
     */
    public void dispose() {
        synchronized (lock) {
            disposed = true;
            armed = false;
            cancelScheduledLocked();
        }
    }

    private void armInternal(long targetAtMs, String normalizedMessage, long realFireAtMs) {
        synchronized (lock) {
            if (disposed) {
                return;
            }
            this.fireAtMs = targetAtMs;
            this.message = normalizedMessage;
            this.armed = true;
            this.busyRetryCount.set(0);
            scheduleFireAtLocked(realFireAtMs);
        }
        host.onArmed(targetAtMs, normalizedMessage);
        LOG.info("[ScheduledSend] Armed for " + targetAtMs
                + " (fires in " + Math.max(0, realFireAtMs - System.currentTimeMillis()) + "ms)");
    }

    private void scheduleFireAtLocked(long realFireAtMs) {
        cancelScheduledLocked();
        long delay = Math.max(0, realFireAtMs - System.currentTimeMillis());
        scheduledSend = scheduler.schedule(this::onFire, delay, TimeUnit.MILLISECONDS);
    }

    private void cancelScheduledLocked() {
        if (scheduledSend != null) {
            scheduledSend.cancel(false);
            scheduledSend = null;
        }
    }

    private void onFire() {
        if (disposed || !armed) {
            return;
        }
        if (!host.isActive()) {
            dispose();
            return;
        }
        if (host.isBusy()) {
            deferForBusySession();
            return;
        }
        String text = message;
        if (text == null || text.isBlank()) {
            disarm();
            return;
        }
        deliver(text);
    }

    private void deferForBusySession() {
        long targetAt = fireAtMs;
        String pending = message;
        int attempt = busyRetryCount.incrementAndGet();
        if (attempt > MAX_BUSY_RETRIES) {
            LOG.info("[ScheduledSend] Session still busy after " + MAX_BUSY_RETRIES
                    + " deferrals; handing the message back to the user.");
            disarm();
            host.onMissed(targetAt, pending);
            return;
        }
        synchronized (lock) {
            if (disposed || !armed) {
                return;
            }
            scheduleFireAtLocked(System.currentTimeMillis() + BUSY_RETRY_DELAY_MS);
        }
        LOG.info("[ScheduledSend] Session busy at the scheduled time (deferral "
                + attempt + "/" + MAX_BUSY_RETRIES + "); retrying in " + BUSY_RETRY_DELAY_MS + "ms.");
    }

    /** Disarm first so the persisted schedule is already cleared when the send runs. */
    private void deliver(String text) {
        disarm();
        try {
            host.send(text);
            LOG.info("[ScheduledSend] Delivered the scheduled message.");
        } catch (Exception e) {
            LOG.warn("[ScheduledSend] Scheduled send threw: " + e.getMessage());
        }
    }

    private void disarm() {
        synchronized (lock) {
            armed = false;
            fireAtMs = 0L;
            message = null;
            busyRetryCount.set(0);
            cancelScheduledLocked();
        }
        host.onDisarmed();
    }
}
