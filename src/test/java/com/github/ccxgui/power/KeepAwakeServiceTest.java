package com.github.ccxgui.power;

import org.junit.After;
import org.junit.Test;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Behaviour of the keep-awake holder bookkeeping, exercised against a fake
 * inhibitor so no real power state is touched.
 *
 * <p>The service is asynchronous by design (all OS calls are pinned to one
 * worker thread), so assertions poll rather than assuming immediate effect.
 */
public class KeepAwakeServiceTest {

    private static final long POLL_TIMEOUT_MS = 3_000L;

    private ScheduledExecutorService worker;
    private KeepAwakeService service;

    @After
    public void tearDown() {
        if (service != null) {
            service.shutdown();
            service = null;
        }
        if (worker != null) {
            worker.shutdownNow();
            worker = null;
        }
    }

    private KeepAwakeService newService(FakeInhibitor inhibitor, long graceMs, BooleanSupplier enabled) {
        worker = Executors.newSingleThreadScheduledExecutor();
        service = new KeepAwakeService(inhibitor, worker, graceMs, enabled);
        return service;
    }

    @Test
    public void doesNothingWhileTheSettingIsOff() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 0L, () -> false);

        keepAwake.acquire(new Object(), "agent busy");

        assertStaysFalse(keepAwake);
        assertEquals(0, inhibitor.engaged.get());
    }

    @Test
    public void engagesOnFirstHolderAndReleasesWhenTheLastOneLeaves() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 0L, () -> true);
        Object token = new Object();

        keepAwake.acquire(token, "agent busy");
        awaitInhibiting(keepAwake, true);
        assertEquals(1, inhibitor.engaged.get());

        keepAwake.release(token);
        awaitInhibiting(keepAwake, false);
        assertEquals(1, inhibitor.disengaged.get());
    }

    @Test
    public void holdsUntilEveryHolderHasLeft() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 0L, () -> true);
        Object busy = new Object();
        Object armed = new Object();

        keepAwake.acquire(busy, "agent busy");
        keepAwake.acquire(armed, "auto-resume armed");
        awaitInhibiting(keepAwake, true);

        // The turn ends but a restart is scheduled: the second holder keeps the hold.
        keepAwake.release(busy);
        assertStaysTrue(keepAwake);
        assertEquals(0, inhibitor.disengaged.get());

        keepAwake.release(armed);
        awaitInhibiting(keepAwake, false);
    }

    @Test
    public void repeatedAcquireAndReleaseOfOneTokenIsIdempotent() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 0L, () -> true);
        Object token = new Object();

        // The busy-flag paths legitimately report the same transition more than
        // once; identity-keyed holders must collapse the repeats.
        keepAwake.acquire(token, "agent busy");
        keepAwake.acquire(token, "agent busy");
        awaitInhibiting(keepAwake, true);
        assertEquals(1, keepAwake.holderCount());

        keepAwake.release(token);
        keepAwake.release(token);
        awaitInhibiting(keepAwake, false);
        assertEquals(0, keepAwake.holderCount());
        assertEquals(1, inhibitor.disengaged.get());
    }

    @Test
    public void aNewHolderDuringTheGracePeriodCancelsTheRelease() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 60_000L, () -> true);
        Object busy = new Object();
        Object limitCheck = new Object();

        keepAwake.acquire(busy, "agent busy");
        awaitInhibiting(keepAwake, true);

        // The turn failed on a usage limit: the busy hold drops and the auto-resume
        // assessment picks it up. The inhibitor must never actually let go.
        keepAwake.release(busy);
        keepAwake.acquire(limitCheck, "usage-limit assessment");

        assertStaysTrue(keepAwake);
        assertEquals(0, inhibitor.disengaged.get());
        assertEquals(1, inhibitor.engaged.get());
    }

    @Test
    public void turningTheSettingOffReleasesImmediatelyAndBackOnReEngages() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 60_000L, () -> true);
        Object token = new Object();

        keepAwake.acquire(token, "agent busy");
        awaitInhibiting(keepAwake, true);

        // Explicit user instruction: bypass the grace period entirely.
        keepAwake.setEnabled(false);
        awaitInhibiting(keepAwake, false);

        // The holder is still registered, so re-enabling takes effect at once
        // rather than waiting for the next turn.
        keepAwake.setEnabled(true);
        awaitInhibiting(keepAwake, true);
        assertEquals(2, inhibitor.engaged.get());
    }

    @Test
    public void shutdownReleasesAnOutstandingHold() throws Exception {
        FakeInhibitor inhibitor = new FakeInhibitor();
        KeepAwakeService keepAwake = newService(inhibitor, 60_000L, () -> true);

        keepAwake.acquire(new Object(), "agent busy");
        awaitInhibiting(keepAwake, true);

        keepAwake.shutdown();
        service = null;
        assertTrue(worker.awaitTermination(POLL_TIMEOUT_MS, TimeUnit.MILLISECONDS));
        assertEquals(1, inhibitor.disengaged.get());
    }

    // ---- helpers -----------------------------------------------------------

    private static void awaitInhibiting(KeepAwakeService keepAwake, boolean expected) throws Exception {
        long deadline = System.currentTimeMillis() + POLL_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (keepAwake.isInhibiting() == expected) {
                return;
            }
            Thread.sleep(5L);
        }
        assertEquals("inhibiting state", expected, keepAwake.isInhibiting());
    }

    /** Assert the hold survives a short settling window (no release was scheduled). */
    private static void assertStaysTrue(KeepAwakeService keepAwake) throws Exception {
        Thread.sleep(150L);
        assertTrue("expected the hold to survive", keepAwake.isInhibiting());
    }

    private static void assertStaysFalse(KeepAwakeService keepAwake) throws Exception {
        Thread.sleep(150L);
        assertFalse("expected no hold to be taken", keepAwake.isInhibiting());
    }

    private static final class FakeInhibitor implements SleepInhibitor {
        private final AtomicInteger engaged = new AtomicInteger();
        private final AtomicInteger disengaged = new AtomicInteger();

        @Override
        public void engage() {
            engaged.incrementAndGet();
        }

        @Override
        public void disengage() {
            disengaged.incrementAndGet();
        }

        @Override
        public String describe() {
            return "fake";
        }
    }
}
