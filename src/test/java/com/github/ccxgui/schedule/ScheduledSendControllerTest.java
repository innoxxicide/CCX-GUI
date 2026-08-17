package com.github.ccxgui.schedule;

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
 * Behavioural tests for the per-window scheduled-send controller: request
 * validation, arming and firing, cancellation, deferral while a turn is in
 * flight with a bounded fallback to a manual send, and the restart freshness
 * policy. The scheduler is injected so the whole flow runs synchronously.
 */
public class ScheduledSendControllerTest {

    private static final String MESSAGE = "Run the release checklist.";

    private static long inMinutes(long minutes) {
        return System.currentTimeMillis() + minutes * 60_000L;
    }

    // ===== request validation =====

    @Test
    public void schedulesAValidFutureRequest() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        long target = inMinutes(30);
        assertEquals(ScheduledSendController.Result.SCHEDULED, controller.schedule(MESSAGE, target));

        assertTrue(controller.isArmed());
        assertEquals(target, controller.getFireAtMs());
        assertEquals(MESSAGE, controller.getMessage());
        assertEquals(1, host.armedCount);
        assertNotNull(scheduler.last);
    }

    @Test
    public void trimsTheScheduledMessage() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        controller.schedule("   " + MESSAGE + "  \n", inMinutes(5));

        assertEquals(MESSAGE, controller.getMessage());
    }

    @Test
    public void rejectsABlankMessage() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        assertEquals(ScheduledSendController.Result.EMPTY_MESSAGE, controller.schedule("   \n ", inMinutes(5)));
        assertEquals(ScheduledSendController.Result.EMPTY_MESSAGE, controller.schedule(null, inMinutes(5)));
        assertFalse(controller.isArmed());
        assertEquals(0, host.armedCount);
    }

    @Test
    public void rejectsAnOverlongMessage() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        String tooLong = "x".repeat(ScheduledSendController.MAX_MESSAGE_LENGTH + 1);

        assertEquals(ScheduledSendController.Result.MESSAGE_TOO_LONG, controller.schedule(tooLong, inMinutes(5)));
        assertFalse(controller.isArmed());
    }

    @Test
    public void rejectsATimeInThePast() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        assertEquals(ScheduledSendController.Result.TIME_IN_PAST, controller.schedule(MESSAGE, inMinutes(-1)));
        assertFalse(controller.isArmed());
    }

    @Test
    public void rejectsATimeBeyondTheLeadLimit() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        long tooFar = System.currentTimeMillis() + ScheduledSendController.MAX_LEAD_MS + 60_000L;

        assertEquals(ScheduledSendController.Result.TOO_FAR_AHEAD, controller.schedule(MESSAGE, tooFar));
        assertFalse(controller.isArmed());
    }

    @Test
    public void reschedulingReplacesThePendingSend() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        FakeFuture first = scheduler.last;
        long second = inMinutes(60);
        controller.schedule("A different message", second);

        assertTrue(first.cancelled);
        assertEquals(second, controller.getFireAtMs());
        assertEquals("A different message", controller.getMessage());
        assertEquals(2, host.armedCount);
    }

    // ===== firing =====

    @Test
    public void sendsWhenTheScheduledTimeArrives() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        scheduler.fireLast();

        assertEquals(MESSAGE, host.lastSent);
        assertFalse(controller.isArmed());
        assertEquals(0L, controller.getFireAtMs());
        assertNull(controller.getMessage());
        // Disarm happens before the send, so the persisted schedule is already gone.
        assertEquals(1, host.disarmedCount);
        assertTrue(host.disarmedBeforeSend);
        assertEquals(0, host.missedCount);
    }

    @Test
    public void doesNotSendIntoAWindowThatWasDisposed() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        host.active = false;
        scheduler.fireLast();

        assertNull(host.lastSent);
        assertFalse(controller.isArmed());
    }

    @Test
    public void defersWhileTheSessionIsBusyThenSends() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        host.busy = true;
        scheduler.fireLast();

        assertNull(host.lastSent);
        assertTrue(controller.isArmed());
        // Computed from the wall clock, so allow for a tick between the two reads.
        assertTrue(scheduler.last.delayMs > ScheduledSendController.BUSY_RETRY_DELAY_MS - 1_000L);
        assertTrue(scheduler.last.delayMs <= ScheduledSendController.BUSY_RETRY_DELAY_MS);

        host.busy = false;
        scheduler.fireLast();

        assertEquals(MESSAGE, host.lastSent);
    }

    @Test
    public void handsBackToTheUserAfterTooManyBusyDeferrals() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        host.busy = true;
        for (int i = 0; i <= ScheduledSendController.MAX_BUSY_RETRIES; i++) {
            scheduler.fireLast();
        }

        assertNull(host.lastSent);
        assertFalse(controller.isArmed());
        assertEquals(1, host.missedCount);
        assertEquals(MESSAGE, host.lastMissedMessage);
    }

    // ===== cancel / send now =====

    @Test
    public void cancelDropsThePendingSend() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        controller.cancel();

        assertFalse(controller.isArmed());
        assertTrue(scheduler.last.cancelled);
        assertEquals(1, host.disarmedCount);

        scheduler.fireLast();
        assertNull(host.lastSent);
    }

    @Test
    public void sendNowDeliversThePendingMessageImmediately() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        // Busy is deliberately ignored here: the click is an explicit override.
        host.busy = true;
        controller.sendNow(null);

        assertEquals(MESSAGE, host.lastSent);
        assertFalse(controller.isArmed());
    }

    @Test
    public void sendNowFallsBackToTheMissedMessage() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        controller.sendNow("A message that missed its slot");

        assertEquals("A message that missed its slot", host.lastSent);
    }

    @Test
    public void sendNowWithNothingPendingIsANoOp() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        controller.sendNow(null);

        assertNull(host.lastSent);
    }

    // ===== restart =====

    @Test
    public void restoreRearmsAStillFutureSchedule() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        long target = inMinutes(45);
        controller.restoreFromPersisted(target, MESSAGE);

        assertTrue(controller.isArmed());
        assertEquals(target, controller.getFireAtMs());
        assertEquals(0, host.missedCount);
    }

    @Test
    public void restoreFiresAScheduleMissedDuringTheRestart() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.restoreFromPersisted(inMinutes(-2), MESSAGE);

        assertTrue(controller.isArmed());
        assertEquals(0L, scheduler.last.delayMs);
        scheduler.fireLast();
        assertEquals(MESSAGE, host.lastSent);
    }

    @Test
    public void restoreDefersAStaleScheduleToTheUser() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        long stale = System.currentTimeMillis()
                - ScheduledSendController.RESTART_FRESHNESS_WINDOW_MS - 60_000L;
        controller.restoreFromPersisted(stale, MESSAGE);

        assertFalse(controller.isArmed());
        assertNull(scheduler.last);
        assertEquals(1, host.missedCount);
        assertEquals(MESSAGE, host.lastMissedMessage);
    }

    @Test
    public void restoreIgnoresAnEmptyOrAbsentSchedule() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.restoreFromPersisted(0L, MESSAGE);
        controller.restoreFromPersisted(inMinutes(10), "   ");
        controller.restoreFromPersisted(inMinutes(10), null);

        assertFalse(controller.isArmed());
        assertEquals(0, host.armedCount);
        assertEquals(0, host.missedCount);
        assertNull(scheduler.last);
    }

    // ===== dispose =====

    @Test
    public void disposeCancelsThePendingSendAndSuppressesTheFire() {
        RecordingHost host = new RecordingHost();
        ManualScheduler scheduler = new ManualScheduler();
        ScheduledSendController controller = new ScheduledSendController(host, scheduler);

        controller.schedule(MESSAGE, inMinutes(30));
        controller.dispose();

        assertTrue(scheduler.last.cancelled);
        scheduler.last.command.run();
        assertNull(host.lastSent);
        // dispose() leaves persisted state alone, so no disarm notification fires.
        assertEquals(0, host.disarmedCount);
    }

    @Test
    public void schedulingAfterDisposeIsRejected() {
        RecordingHost host = new RecordingHost();
        ScheduledSendController controller = new ScheduledSendController(host, new ManualScheduler());

        controller.dispose();

        assertEquals(ScheduledSendController.Result.EMPTY_MESSAGE, controller.schedule(MESSAGE, inMinutes(10)));
        assertFalse(controller.isArmed());
    }

    // ===== fakes =====

    private static final class RecordingHost implements ScheduledSendController.Host {
        boolean active = true;
        boolean busy = false;
        int armedCount = 0;
        int disarmedCount = 0;
        int missedCount = 0;
        String lastSent = null;
        String lastMissedMessage = null;
        boolean disarmedBeforeSend = false;

        @Override
        public boolean isActive() {
            return active;
        }

        @Override
        public boolean isBusy() {
            return busy;
        }

        @Override
        public void onArmed(long fireAtMs, String message) {
            armedCount++;
        }

        @Override
        public void send(String message) {
            disarmedBeforeSend = disarmedCount > 0;
            lastSent = message;
        }

        @Override
        public void onMissed(long fireAtMs, String message) {
            missedCount++;
            lastMissedMessage = message;
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
