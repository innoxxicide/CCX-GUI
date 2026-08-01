package com.github.ccxgui.power;

import com.intellij.openapi.diagnostic.Logger;
import com.sun.jna.platform.win32.Kernel32;

/**
 * Windows backend built on {@code kernel32!SetThreadExecutionState}.
 *
 * <p>JNA ships inside the IDE itself ({@code lib/util-8.jar} plus the native
 * {@code jnidispatch} library), so this adds no dependency to the plugin.
 *
 * <p>Two properties of the Win32 API shape this class:
 * <ul>
 *   <li><b>The request belongs to the calling thread.</b> Windows clears it when
 *       that thread exits, which is why {@link SleepInhibitor} pins every call to
 *       one long-lived worker thread.</li>
 *   <li><b>The request dies with the process.</b> If the IDE is killed there is
 *       nothing to clean up — unlike the child-process backends, no orphan can
 *       survive and hold the machine awake.</li>
 * </ul>
 *
 * <p>Only {@code ES_SYSTEM_REQUIRED} is requested, deliberately without
 * {@code ES_DISPLAY_REQUIRED}: the goal is to keep the agent running, not to
 * burn the backlight, so the monitor stays free to sleep.
 */
final class WindowsSleepInhibitor implements SleepInhibitor {

    private static final Logger LOG = Logger.getInstance(WindowsSleepInhibitor.class);

    /** Keep the request in force until it is explicitly cleared. */
    private static final int ES_CONTINUOUS = 0x80000000;
    /** Reset the system idle timer on every call. */
    private static final int ES_SYSTEM_REQUIRED = 0x00000001;

    @Override
    public void engage() {
        apply(ES_CONTINUOUS | ES_SYSTEM_REQUIRED, "engage");
    }

    @Override
    public void disengage() {
        apply(ES_CONTINUOUS, "disengage");
    }

    private void apply(int flags, String label) {
        try {
            // Returns the previous state, or 0 on failure.
            int previous = Kernel32.INSTANCE.SetThreadExecutionState(flags);
            if (previous == 0) {
                LOG.warn("[KeepAwake] SetThreadExecutionState(" + label + ") failed, lastError="
                        + Kernel32.INSTANCE.GetLastError());
            }
        } catch (Throwable t) {
            // Throwable, not Exception: a missing jnidispatch for the current
            // architecture surfaces as UnsatisfiedLinkError/NoClassDefFoundError.
            // Degrading to "sleep is not inhibited" is always preferable to
            // breaking the turn that triggered this.
            LOG.warn("[KeepAwake] SetThreadExecutionState unavailable (" + label + "): " + t);
        }
    }

    @Override
    public String describe() {
        return "SetThreadExecutionState (Windows)";
    }
}
