package com.github.ccxgui.schedule;

import com.github.ccxgui.settings.AutoRetrySettings;
import com.github.ccxgui.settings.CodemossSettingsService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Per-window controller that nudges an agent back to work after its turn died on
 * an error.
 *
 * <p>Lifecycle, in one sentence: a turn ends in a non-usage-limit error → we
 * <em>engage</em> and send the configured prompt a minute later → if that turn
 * fails too we send again, three times a minute apart and every five minutes
 * after that → the first turn that finishes without an error <em>disengages</em>
 * us.
 *
 * <h3>One recovery run per outage</h3>
 * The defining rule: once engaged, further turn errors do <em>not</em> restart
 * anything. An API error answered by another API error is the same outage still
 * in progress, so it advances the existing schedule rather than resetting the
 * attempt count back to a one-minute cadence — which is exactly the runaway an
 * unconditional "retry on error" would produce.
 *
 * <h3>Usage limits are not this feature's problem</h3>
 * A usage-limit stop is not transient and retrying cannot fix it. Those are
 * handled by {@code ClaudeAutoResumeController}, which waits for the reset time.
 * A limit error therefore never engages this controller, and one arriving while
 * it <em>is</em> engaged stands it down so the two never send into the same
 * session at once.
 *
 * <h3>Not provider-specific</h3>
 * Any provider's turn can fail this way, so — unlike auto-resume — nothing here
 * inspects the session's provider. It owns no UI and no persistence; both are
 * delegated to a {@link Host} the window supplies, which keeps this class
 * testable and free of a {@code ui} → {@code schedule} layering dependency.
 *
 * <p>Deliberately not persisted across IDE restarts: a retry run is a reaction to
 * a live failure, and replaying one into a session the user has since walked away
 * from would start work behind their back.
 */
public final class AutoRetryController {

    private static final Logger LOG = Logger.getInstance(AutoRetryController.class);

    /** Delay before each of the first {@link #FAST_ATTEMPTS} nudges. */
    static final long FAST_RETRY_DELAY_MS = 60_000L;
    /** Delay before every nudge after that, for as long as the agent keeps failing. */
    static final long SLOW_RETRY_DELAY_MS = 300_000L;
    /** How many nudges use the fast cadence before backing off to the slow one. */
    static final int FAST_ATTEMPTS = 3;
    /** How long to wait before re-checking when a turn was already running at fire time. */
    static final long BUSY_RETRY_DELAY_MS = 30_000L;
    /**
     * How long a sent nudge may go without producing a turn outcome before we
     * assume the outcome was lost. Only concludes that while the session is
     * <em>idle</em> — a turn still running is working, however long it takes.
     */
    static final long OUTCOME_WATCHDOG_DELAY_MS = 60_000L;

    /**
     * The window's collaboration surface: session access, liveness and UI
     * notifications. All methods may be called off the EDT — the fire path runs on
     * a pooled scheduler thread — so implementations marshal where their own APIs
     * require it.
     */
    public interface Host {
        /** {@code false} once the window is disposed; stops all scheduled work. */
        boolean isActive();

        /** Whether a turn is currently in flight, in which case the nudge is deferred. */
        boolean isBusy();

        /**
         * A recovery run is now in progress and the next nudge is scheduled.
         * {@code attempt} is 1-based and {@code nextAttemptAtMs} is when it fires;
         * both are for display only.
         */
        void onEngaged(int attempt, long nextAttemptAtMs);

        /** Send {@code prompt} to the session as a user message to restart the work. */
        void retry(String prompt);

        /** No recovery run is in progress anymore; clear any indicator. */
        void onDisengaged();
    }

    private final Host host;
    private final CodemossSettingsService settings;
    private final ScheduledExecutorService scheduler;

    private final Object lock = new Object();

    private volatile boolean disposed = false;
    /**
     * The run's single pending timer. What it means depends on
     * {@link #awaitingOutcome}: send the next nudge, or check on one already sent.
     */
    private ScheduledFuture<?> scheduledRetry;
    private volatile boolean engaged = false;
    /** How many nudges have been scheduled in this run; 1-based, 0 when disengaged. */
    private volatile int attempt = 0;
    /** When the pending nudge fires, or {@code 0} when none is scheduled. */
    private volatile long nextAttemptAtMs = 0L;
    /** A nudge has been sent and no turn outcome has come back for it yet. */
    private volatile boolean awaitingOutcome = false;

    public AutoRetryController(Host host, CodemossSettingsService settings) {
        this(host, settings, AppExecutorUtil.getAppScheduledExecutorService());
    }

    AutoRetryController(Host host, CodemossSettingsService settings, ScheduledExecutorService scheduler) {
        this.host = host;
        this.settings = settings;
        this.scheduler = scheduler;
    }

    /** Whether a recovery run is in progress. */
    public boolean isEngaged() {
        return engaged;
    }

    /** The 1-based number of the pending nudge, or {@code 0} when disengaged. */
    public int getAttempt() {
        return attempt;
    }

    /** When the pending nudge fires, or {@code 0} when none is scheduled. */
    public long getNextAttemptAtMs() {
        return nextAttemptAtMs;
    }

    /**
     * Entry point wired from the window's session callback: a turn ended in an
     * error.
     *
     * @param error        the reported error, for logging only — the decision does
     *                     not depend on the text
     * @param isUsageLimit whether this was a usage-limit stop, which belongs to
     *                     auto-resume and stands this controller down instead
     */
    public void onTurnError(String error, boolean isUsageLimit) {
        if (disposed) {
            return;
        }
        if (isUsageLimit) {
            if (engaged) {
                // Auto-resume owns the session from here: it will wait out the reset
                // rather than nudging a blocked account every five minutes.
                LOG.info("[AutoRetry] Usage limit reached mid-recovery; standing down for auto-resume.");
                disengage();
            }
            return;
        }
        if (!isEnabled()) {
            return;
        }
        if (engaged) {
            // Still the same outage. Advance the existing schedule instead of
            // restarting it, so repeated failures cannot pin us to the fast cadence.
            scheduleNextAttempt();
            return;
        }
        LOG.info("[AutoRetry] Turn failed, starting recovery: " + abbreviate(error));
        scheduleNextAttempt();
    }

    /**
     * A turn finished without reporting an error. That is the only evidence the
     * agent is answering again, so it ends the recovery run — whether the turn was
     * one of ours or one the user sent by hand.
     */
    public void onTurnSuccess() {
        if (disposed || !engaged) {
            return;
        }
        LOG.info("[AutoRetry] Agent responded normally after " + attempt + " attempt(s); recovery complete.");
        disengage();
    }

    /** User asked to stop retrying. */
    public void cancel() {
        if (disposed || !engaged) {
            return;
        }
        LOG.info("[AutoRetry] Recovery cancelled by the user after " + attempt + " attempt(s).");
        disengage();
    }

    /**
     * Stop all scheduled work. Called from window dispose (tab close or IDE
     * shutdown); nothing is persisted, so a run simply ends with its window.
     */
    public void dispose() {
        synchronized (lock) {
            disposed = true;
            engaged = false;
            cancelScheduledLocked();
        }
    }

    /**
     * Arm the next nudge, advancing the attempt counter. The first
     * {@link #FAST_ATTEMPTS} run a minute apart; everything after backs off to
     * {@link #SLOW_RETRY_DELAY_MS}, indefinitely — an outage that outlasts the fast
     * attempts needs patience, not surrender, and the user can stop it at any time.
     */
    private void scheduleNextAttempt() {
        int nextAttempt;
        long fireAt;
        synchronized (lock) {
            if (disposed) {
                return;
            }
            nextAttempt = attempt + 1;
            long delay = nextAttempt <= FAST_ATTEMPTS ? FAST_RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS;
            fireAt = System.currentTimeMillis() + delay;
            attempt = nextAttempt;
            nextAttemptAtMs = fireAt;
            engaged = true;
            awaitingOutcome = false;
            scheduleFireAtLocked(fireAt);
        }
        host.onEngaged(nextAttempt, fireAt);
        LOG.info("[AutoRetry] Attempt " + nextAttempt + " scheduled in "
                + Math.max(0, fireAt - System.currentTimeMillis()) + "ms.");
    }

    private void scheduleFireAtLocked(long fireAtMs) {
        cancelScheduledLocked();
        long delay = Math.max(0, fireAtMs - System.currentTimeMillis());
        scheduledRetry = scheduler.schedule(this::onRetryFire, delay, TimeUnit.MILLISECONDS);
    }

    private void cancelScheduledLocked() {
        if (scheduledRetry != null) {
            scheduledRetry.cancel(false);
            scheduledRetry = null;
        }
    }

    private void onRetryFire() {
        if (disposed || !engaged) {
            return;
        }
        if (!host.isActive()) {
            dispose();
            return;
        }
        if (!isEnabled()) {
            // The user turned the feature off while a run was in progress. Only the
            // start of a run is otherwise gated, so without this check the run would
            // keep sending long after the toggle said to stop.
            LOG.info("[AutoRetry] Feature disabled mid-recovery; stopping the run.");
            disengage();
            return;
        }
        if (awaitingOutcome) {
            checkSentNudge();
            return;
        }
        if (host.isBusy()) {
            // A turn is running — the user sent something, or a previous nudge is
            // still being answered. Sending now would interleave with it; wait, and
            // let that turn's own outcome decide whether we are still needed.
            deferBy(BUSY_RETRY_DELAY_MS, "a turn is already running");
            return;
        }
        // Stay engaged across the send: only a turn ending without an error
        // disengages us, and that turn has not happened yet.
        String prompt = resolvePrompt();
        try {
            awaitingOutcome = true;
            deferBy(OUTCOME_WATCHDOG_DELAY_MS, "watching for the outcome of attempt " + attempt);
            host.retry(prompt);
            LOG.info("[AutoRetry] Sent recovery prompt (attempt " + attempt + ").");
        } catch (Exception e) {
            LOG.warn("[AutoRetry] Recovery send threw: " + e.getMessage());
            // The send never reached the agent, so no turn outcome is coming to
            // advance the schedule. Arm the next attempt ourselves.
            scheduleNextAttempt();
        }
    }

    /**
     * A nudge was sent and nothing came back yet. If a turn is running it is simply
     * taking its time — agent turns legitimately run for many minutes — so keep
     * watching. If the session is idle, the outcome was lost (a dropped callback, a
     * send that never opened a turn) and the run would otherwise stall here
     * forever, so treat it as a failed attempt.
     */
    private void checkSentNudge() {
        if (host.isBusy()) {
            deferBy(OUTCOME_WATCHDOG_DELAY_MS, "attempt " + attempt + " is still running");
            return;
        }
        LOG.info("[AutoRetry] No turn outcome came back for attempt " + attempt
                + " and the session is idle; treating it as failed.");
        scheduleNextAttempt();
    }

    /** Re-arm the pending timer without advancing the attempt counter. */
    private void deferBy(long delayMs, String reason) {
        long fireAt = System.currentTimeMillis() + delayMs;
        synchronized (lock) {
            if (disposed || !engaged) {
                return;
            }
            // A watchdog tick is not a scheduled nudge, so it must not be advertised
            // as one: while a nudge is in flight there is no "next attempt at" to show.
            nextAttemptAtMs = awaitingOutcome ? 0L : fireAt;
            scheduleFireAtLocked(fireAt);
        }
        LOG.debug("[AutoRetry] Re-checking in " + delayMs + "ms — " + reason + ".");
    }

    private void disengage() {
        synchronized (lock) {
            engaged = false;
            attempt = 0;
            nextAttemptAtMs = 0L;
            awaitingOutcome = false;
            cancelScheduledLocked();
        }
        host.onDisengaged();
    }

    private boolean isEnabled() {
        try {
            return settings.getAutoRetryEnabled();
        } catch (IOException e) {
            LOG.warn("[AutoRetry] Could not read enabled flag: " + e.getMessage());
            return false;
        }
    }

    private String resolvePrompt() {
        try {
            String prompt = settings.getAutoRetryPrompt();
            if (prompt != null && !prompt.isBlank()) {
                return prompt;
            }
        } catch (IOException e) {
            LOG.warn("[AutoRetry] Could not read retry prompt: " + e.getMessage());
        }
        return AutoRetrySettings.DEFAULT_AUTO_RETRY_PROMPT;
    }

    private static String abbreviate(String error) {
        if (error == null) {
            return "(no message)";
        }
        String single = error.replace('\n', ' ');
        return single.length() > 200 ? single.substring(0, 200) + "…" : single;
    }
}
