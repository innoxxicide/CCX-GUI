package com.github.ccxgui.schedule;

import com.github.ccxgui.settings.CodemossSettingsService;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Delayed;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Behavioural tests for the auto-retry-on-error controller: the escalating
 * cadence, the "one recovery run per outage" rule, the usage-limit hand-off to
 * auto-resume, recovery detection, the busy-session deferral and the lost-outcome
 * watchdog. The scheduler is injected so the whole flow runs synchronously.
 */
public class AutoRetryControllerTest {

    private static final String PROMPT = "Continue working on the task.";

    // ===== engaging =====

    @Test
    public void engagesOnAnErrorAndSchedulesTheFirstNudgeAMinuteOut() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);

        assertTrue(controller.isEngaged());
        assertEquals(1, controller.getAttempt());
        assertEquals(AutoRetryController.FAST_RETRY_DELAY_MS, scheduler.lastDelayMs());
        assertEquals(1, host.engagedCount);
        assertNull(host.lastRetryPrompt);
    }

    @Test
    public void inertWhenDisabled() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, false, PROMPT);

        controller.onTurnError("API Error: 500", false);

        assertFalse(controller.isEngaged());
        assertNull(scheduler.last);
    }

    @Test
    public void ignoresUsageLimitStops() {
        // Those are not transient and belong to auto-resume, which waits for the
        // reset instead of nudging a blocked account.
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("You've hit your session limit", true);

        assertFalse(controller.isEngaged());
        assertEquals(0, host.engagedCount);
        assertNull(scheduler.last);
    }

    @Test
    public void sendsTheConfiguredPromptWhenTheNudgeFires() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, "custom nudge");

        controller.onTurnError("API Error: 500", false);
        scheduler.fireLast();

        assertEquals("custom nudge", host.lastRetryPrompt);
        assertEquals(1, host.retryCount);
        // Still engaged: only a turn that ends without an error ends the run.
        assertTrue(controller.isEngaged());
    }

    // ===== one recovery run per outage =====

    @Test
    public void repeatedErrorsAdvanceTheRunInsteadOfRestartingIt() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        assertEquals(1, controller.getAttempt());

        // Nudge 1 goes out and is answered by another failure.
        scheduler.fireLast();
        controller.onTurnError("API Error: 500", false);

        assertEquals(2, controller.getAttempt());
        assertEquals(AutoRetryController.FAST_RETRY_DELAY_MS, scheduler.lastDelayMs());
        // One engage per attempt, not one per error — the run was never restarted.
        assertEquals(2, host.engagedCount);
    }

    @Test
    public void backsOffToFiveMinutesAfterThreeFastAttempts() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        for (int i = 1; i <= AutoRetryController.FAST_ATTEMPTS; i++) {
            assertEquals("attempt " + i + " cadence",
                    AutoRetryController.FAST_RETRY_DELAY_MS, scheduler.lastDelayMs());
            scheduler.fireLast();
            controller.onTurnError("API Error: 500", false);
        }

        assertEquals(AutoRetryController.FAST_ATTEMPTS + 1, controller.getAttempt());
        assertEquals(AutoRetryController.SLOW_RETRY_DELAY_MS, scheduler.lastDelayMs());
    }

    @Test
    public void staysOnTheSlowCadenceIndefinitely() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        for (int i = 0; i < 12; i++) {
            scheduler.fireLast();
            controller.onTurnError("API Error: 500", false);
        }

        assertTrue(controller.isEngaged());
        assertEquals(AutoRetryController.SLOW_RETRY_DELAY_MS, scheduler.lastDelayMs());
        assertEquals(13, controller.getAttempt());
    }

    // ===== ending the run =====

    @Test
    public void aSuccessfulTurnEndsTheRun() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        scheduler.fireLast();
        controller.onTurnSuccess();

        assertFalse(controller.isEngaged());
        assertEquals(0, controller.getAttempt());
        assertEquals(1, host.disengagedCount);
        assertTrue(scheduler.last.isCancelled());
    }

    @Test
    public void aSuccessfulTurnTheUserSentAlsoEndsTheRun() {
        // Recovery means the agent is answering again; who asked does not matter.
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        controller.onTurnSuccess();

        assertFalse(controller.isEngaged());
        assertEquals(0, host.retryCount);
    }

    @Test
    public void cancelStopsTheRun() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        controller.cancel();
        scheduler.fireLast();

        assertFalse(controller.isEngaged());
        assertEquals(0, host.retryCount);
        assertEquals(1, host.disengagedCount);
    }

    @Test
    public void turningTheFeatureOffMidRunStopsIt() {
        // Only the start of a run is otherwise gated on the toggle, so without a
        // fire-time check the run would keep sending after the user said stop.
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        MutableSettings settings = new MutableSettings(true, PROMPT);
        AutoRetryController controller = new AutoRetryController(host, settings, scheduler);

        controller.onTurnError("API Error: 500", false);
        settings.enabled = false;
        scheduler.fireLast();

        assertFalse(controller.isEngaged());
        assertEquals(0, host.retryCount);
        assertEquals(1, host.disengagedCount);
    }

    @Test
    public void aUsageLimitMidRunStandsDownForAutoResume() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        scheduler.fireLast();
        controller.onTurnError("You've hit your session limit", true);

        assertFalse(controller.isEngaged());
        assertEquals(1, host.disengagedCount);
    }

    @Test
    public void aSuccessWithNoRunInProgressIsIgnored() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnSuccess();

        assertFalse(controller.isEngaged());
        assertEquals(0, host.disengagedCount);
    }

    // ===== busy session =====

    @Test
    public void defersWithoutSendingWhileATurnIsRunning() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        host.busy = true;
        scheduler.fireLast();

        assertEquals(0, host.retryCount);
        assertEquals(1, controller.getAttempt());
        assertEquals(AutoRetryController.BUSY_RETRY_DELAY_MS, scheduler.lastDelayMs());

        host.busy = false;
        scheduler.fireLast();
        assertEquals(1, host.retryCount);
    }

    // ===== lost-outcome watchdog =====

    @Test
    public void treatsASentNudgeWithNoOutcomeAsFailedOnceTheSessionIsIdle() {
        // Without this the run would stall forever on a dropped callback.
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        scheduler.fireLast();
        assertEquals(1, host.retryCount);
        assertEquals(AutoRetryController.OUTCOME_WATCHDOG_DELAY_MS, scheduler.lastDelayMs());

        scheduler.fireLast();

        assertEquals(2, controller.getAttempt());
        assertEquals(AutoRetryController.FAST_RETRY_DELAY_MS, scheduler.lastDelayMs());
        assertEquals(1, host.retryCount);
    }

    @Test
    public void keepsWaitingWhileTheNudgedTurnIsStillRunning() {
        // Agent turns legitimately run for many minutes; a long turn is not a lost one.
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        scheduler.fireLast();
        host.busy = true;
        scheduler.fireLast();
        scheduler.fireLast();

        assertEquals(1, host.retryCount);
        assertEquals(1, controller.getAttempt());
        assertEquals(AutoRetryController.OUTCOME_WATCHDOG_DELAY_MS, scheduler.lastDelayMs());
    }

    @Test
    public void aSendThatThrowsStillSchedulesTheNextAttempt() {
        RecordingHost host = new RecordingHost();
        host.throwOnRetry = true;
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        scheduler.fireLast();

        assertTrue(controller.isEngaged());
        assertEquals(2, controller.getAttempt());
        assertEquals(AutoRetryController.FAST_RETRY_DELAY_MS, scheduler.lastDelayMs());
    }

    // ===== dispose =====

    @Test
    public void disposeCancelsTheScheduledNudgeAndSuppressesFire() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        controller.dispose();
        scheduler.fireLast();

        assertTrue(scheduler.last.isCancelled());
        assertEquals(0, host.retryCount);
        assertFalse(controller.isEngaged());
    }

    @Test
    public void aDisposedWindowEndsTheRunAtFireTime() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        AutoRetryController controller = controller(host, scheduler, true, PROMPT);

        controller.onTurnError("API Error: 500", false);
        host.active = false;
        scheduler.fireLast();

        assertFalse(controller.isEngaged());
        assertEquals(0, host.retryCount);
    }

    // ===== helpers =====

    private static AutoRetryController controller(RecordingHost host, ManualScheduler scheduler,
                                                  boolean enabled, String prompt) {
        return new AutoRetryController(host, stubSettings(enabled, prompt), scheduler);
    }

    private static CodemossSettingsService stubSettings(boolean enabled, String prompt) {
        return new MutableSettings(enabled, prompt);
    }

    /** Settings stub whose toggle can be flipped mid-test. */
    private static final class MutableSettings extends CodemossSettingsService {
        boolean enabled;
        final String prompt;

        MutableSettings(boolean enabled, String prompt) {
            this.enabled = enabled;
            this.prompt = prompt;
        }

        @Override
        public boolean getAutoRetryEnabled() {
            return enabled;
        }

        @Override
        public String getAutoRetryPrompt() {
            return prompt;
        }
    }

    /** Records the controller's host-facing side effects. */
    private static final class RecordingHost implements AutoRetryController.Host {
        boolean active = true;
        boolean busy = false;
        boolean throwOnRetry = false;
        int engagedCount;
        int disengagedCount;
        int retryCount;
        String lastRetryPrompt;

        @Override
        public boolean isActive() {
            return active;
        }

        @Override
        public boolean isBusy() {
            return busy;
        }

        @Override
        public void onEngaged(int attempt, long nextAttemptAtMs) {
            engagedCount++;
        }

        @Override
        public void retry(String prompt) {
            if (throwOnRetry) {
                throw new IllegalStateException("send failed");
            }
            retryCount++;
            lastRetryPrompt = prompt;
        }

        @Override
        public void onDisengaged() {
            disengagedCount++;
        }
    }

    /** Captures scheduled tasks so the test fires them on demand. */
    private static final class ManualScheduler implements ScheduledExecutorService {
        private FakeFuture last;

        void fireLast() {
            if (last != null && !last.cancelled) {
                last.command.run();
            }
        }

        long lastDelayMs() {
            return last != null ? last.delayMs : -1L;
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            last = new FakeFuture(command, unit.toMillis(delay));
            return last;
        }

        @Override
        public <V> ScheduledFuture<V> schedule(Callable<V> callable, long delay, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override
        public ScheduledFuture<?> scheduleAtFixedRate(Runnable c, long i, long p, TimeUnit u) {
            throw new UnsupportedOperationException();
        }

        @Override
        public ScheduledFuture<?> scheduleWithFixedDelay(Runnable c, long i, long d, TimeUnit u) {
            throw new UnsupportedOperationException();
        }

        @Override public void shutdown() { }
        @Override public List<Runnable> shutdownNow() { return new ArrayList<>(); }
        @Override public boolean isShutdown() { return false; }
        @Override public boolean isTerminated() { return false; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return true; }
        @Override public <T> Future<T> submit(Callable<T> task) { throw new UnsupportedOperationException(); }
        @Override public <T> Future<T> submit(Runnable task, T result) { throw new UnsupportedOperationException(); }
        @Override public Future<?> submit(Runnable task) { throw new UnsupportedOperationException(); }
        @Override public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> t) { throw new UnsupportedOperationException(); }
        @Override public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> t, long to, TimeUnit u) { throw new UnsupportedOperationException(); }
        @Override public <T> T invokeAny(Collection<? extends Callable<T>> t) { throw new UnsupportedOperationException(); }
        @Override public <T> T invokeAny(Collection<? extends Callable<T>> t, long to, TimeUnit u) { throw new UnsupportedOperationException(); }
        @Override public void execute(Runnable command) { command.run(); }
    }

    private static final class FakeFuture implements ScheduledFuture<Object> {
        private final Runnable command;
        private final long delayMs;
        private boolean cancelled;

        FakeFuture(Runnable command, long delayMs) {
            this.command = command;
            this.delayMs = delayMs;
        }

        @Override public long getDelay(TimeUnit unit) { return unit.convert(delayMs, TimeUnit.MILLISECONDS); }
        @Override public int compareTo(Delayed o) { return Long.compare(delayMs, o.getDelay(TimeUnit.MILLISECONDS)); }
        @Override public boolean cancel(boolean mayInterruptIfRunning) { cancelled = true; return true; }
        @Override public boolean isCancelled() { return cancelled; }
        @Override public boolean isDone() { return cancelled; }
        @Override public Object get() { return null; }
        @Override public Object get(long timeout, TimeUnit unit) { return null; }
    }
}
