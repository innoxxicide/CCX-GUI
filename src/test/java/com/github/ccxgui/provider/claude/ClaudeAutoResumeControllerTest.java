package com.github.ccxgui.provider.claude;

import com.github.ccxgui.settings.ClaudeAutoResumeSettings;
import com.github.ccxgui.settings.CodemossSettingsService;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Delayed;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Behavioural tests for the per-window auto-resume controller: arming on a real
 * usage-limit error, verify-before-send at wake time (including the hysteresis
 * gate), bounded retries with manual fallback, the enabled/Claude gate, and the
 * restart freshness policy. Usage fetches and the scheduler are injected so the
 * whole flow runs synchronously and deterministically.
 */
public class ClaudeAutoResumeControllerTest {

    private static final String PROMPT = "Please continue where you left off.";

    // ===== arming =====

    @Test
    public void armsOnLimitErrorAndSchedulesWake() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(99.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");

        assertTrue(controller.isArmed());
        assertEquals(1, host.armedCount);
        assertTrue(host.lastArmedWindows.contains("five_hour"));
        assertEquals(futureMillis(), controller.getWakeAtMs());
        assertNotNull(scheduler.last);
    }

    @Test
    public void ignoresNonLimitErrors() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(available("\"five_hour\":" + window(10.0, futureIso())));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("some transient network error");

        assertFalse(controller.isArmed());
        assertEquals(0, host.armedCount);
        assertNull(scheduler.last);
    }

    @Test
    public void inertWhenDisabled() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, false, PROMPT);

        controller.onTurnError("usage limit reached");

        assertFalse(controller.isArmed());
        assertEquals(0, host.armedCount);
    }

    @Test
    public void inertForNonClaudeProvider() {
        RecordingHost host = new RecordingHost("codex");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");

        assertFalse(controller.isArmed());
    }

    @Test
    public void ignoresFurtherErrorsWhileArmed() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");
        controller.onTurnError("usage limit reached again");

        assertEquals(1, host.armedCount);
    }

    // ===== wake-time verify-before-send =====

    @Test
    public void resumesWhenBlockClearedAtWake() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");
        payload.set(available("\"five_hour\":" + window(8.0, futureIso())));
        scheduler.fireLast();

        assertEquals(PROMPT, host.lastResumePrompt);
        assertFalse(controller.isArmed());
        assertEquals(0L, controller.getWakeAtMs());
        assertTrue(host.disarmedCount >= 1);
    }

    @Test
    public void reschedulesWhenStillExhaustedAtWake() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(99.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");
        ScheduledFuture<?> first = scheduler.last;
        scheduler.fireLast();

        assertNull(host.lastResumePrompt);
        assertTrue(controller.isArmed());
        // A fresh wake was scheduled (retry), distinct from the first.
        assertTrue(scheduler.last != first);
    }

    @Test
    public void reschedulesWithinHysteresisGap() {
        // Below EXHAUSTED (95) so assess() reports no limit, but at/above CLEARED
        // (90) so the previously-exhausted window is not yet verifiably reset.
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");
        payload.set(available("\"five_hour\":" + window(92.0, futureIso())));
        scheduler.fireLast();

        assertNull(host.lastResumePrompt);
        assertTrue(controller.isArmed());
    }

    @Test
    public void fallsBackToManualAfterMaxRetries() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        // resets_at in the past keeps the window exhausted without ever "resetting".
        AtomicReference<String> payload = new AtomicReference<>(exhausted(99.0, pastIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");
        for (int i = 0; i <= ClaudeAutoResumeController.MAX_RETRIES; i++) {
            scheduler.fireLast();
        }

        assertEquals(1, host.manualCount);
        assertFalse(controller.isArmed());
        assertNull(host.lastResumePrompt);
    }

    @Test
    public void usesConfiguredResumePrompt() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, "custom resume text");

        controller.onTurnError("usage limit reached");
        payload.set(available("\"five_hour\":" + window(5.0, futureIso())));
        scheduler.fireLast();

        assertEquals("custom resume text", host.lastResumePrompt);
    }

    // ===== restart restore =====

    @Test
    public void restoreFutureWakeRearms() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        long futureWake = System.currentTimeMillis() + 60 * 60_000L;
        controller.restoreFromPersisted(futureWake);

        assertTrue(controller.isArmed());
        assertEquals(futureWake, controller.getWakeAtMs());
        assertNotNull(scheduler.last);
    }

    @Test
    public void restoreStaleWakeDefersToManual() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        long staleWake = System.currentTimeMillis()
                - ClaudeAutoResumeController.RESTART_FRESHNESS_WINDOW_MS - 60_000L;
        controller.restoreFromPersisted(staleWake);

        assertFalse(controller.isArmed());
        assertEquals(1, host.manualCount);
        assertNull(scheduler.last);
    }

    @Test
    public void restoreFreshWakeVerifiesThenResumes() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(available("\"five_hour\":" + window(6.0, futureIso())));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        long recentWake = System.currentTimeMillis() - 5 * 60_000L;
        controller.restoreFromPersisted(recentWake);
        assertTrue(controller.isArmed());
        scheduler.fireLast();

        assertEquals(PROMPT, host.lastResumePrompt);
        assertFalse(controller.isArmed());
    }

    @Test
    public void restoreIgnoresZeroWake() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.restoreFromPersisted(0L);

        assertFalse(controller.isArmed());
        assertEquals(0, host.armedCount);
    }

    // ===== dispose =====

    @Test
    public void disposeCancelsScheduledWakeAndSuppressesFire() {
        RecordingHost host = new RecordingHost("claude");
        ManualScheduler scheduler = new ManualScheduler();
        AtomicReference<String> payload = new AtomicReference<>(exhausted(100.0, futureIso()));
        ClaudeAutoResumeController controller = controller(host, scheduler, payload, true, PROMPT);

        controller.onTurnError("usage limit reached");
        controller.dispose();
        payload.set(available("\"five_hour\":" + window(5.0, futureIso())));
        scheduler.fireLast();

        assertTrue(scheduler.last.isCancelled());
        assertNull(host.lastResumePrompt);
        assertFalse(controller.isArmed());
    }

    // ===== helpers =====

    private static ClaudeAutoResumeController controller(RecordingHost host, ManualScheduler scheduler,
                                                         AtomicReference<String> payload,
                                                         boolean enabled, String prompt) {
        return new ClaudeAutoResumeController(host, stubSettings(enabled, prompt), scheduler,
                () -> CompletableFuture.completedFuture(payload.get()));
    }

    private static CodemossSettingsService stubSettings(boolean enabled, String prompt) {
        return new CodemossSettingsService() {
            @Override
            public boolean getClaudeAutoResumeEnabled() {
                return enabled;
            }

            @Override
            public String getClaudeAutoResumePrompt() {
                return prompt;
            }
        };
    }

    private static String futureIso() {
        return java.time.Instant.ofEpochMilli(futureMillis()).toString();
    }

    private static long futureMillis() {
        // Fixed far-future instant so wake math never lands in the past mid-test.
        return java.time.Instant.parse("2099-01-01T00:00:00Z").toEpochMilli();
    }

    private static String pastIso() {
        return "2000-01-01T00:00:00Z";
    }

    private static String window(double utilization, String resetsAtIso) {
        return "{\"utilization\":" + utilization + ",\"resets_at\":\"" + resetsAtIso + "\"}";
    }

    private static String available(String usageBody) {
        return "{\"available\":true,\"usage\":{" + usageBody + "}}";
    }

    private static String exhausted(double utilization, String resetsAtIso) {
        return available("\"five_hour\":" + window(utilization, resetsAtIso));
    }

    /** Records the controller's host-facing side effects. */
    private static final class RecordingHost implements ClaudeAutoResumeController.Host {
        private final String provider;
        int armedCount;
        int disarmedCount;
        int manualCount;
        Set<String> lastArmedWindows = java.util.Collections.emptySet();
        String lastResumePrompt;

        RecordingHost(String provider) {
            this.provider = provider;
        }

        @Override
        public String provider() {
            return provider;
        }

        @Override
        public boolean isActive() {
            return true;
        }

        @Override
        public void onArmed(long wakeAtMs, Set<String> exhaustedWindows) {
            armedCount++;
            lastArmedWindows = exhaustedWindows;
        }

        @Override
        public void resume(String prompt) {
            lastResumePrompt = prompt;
        }

        @Override
        public void onManualResumeNeeded(long wakeAtMs) {
            manualCount++;
        }

        @Override
        public void onDisarmed() {
            disarmedCount++;
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
