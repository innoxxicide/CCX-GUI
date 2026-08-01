package com.github.ccxgui.power;

/**
 * Platform-specific "do not let this machine fall asleep" primitive.
 *
 * <p>Implementations suppress <em>automatic idle sleep</em> only. Neither macOS's
 * {@code caffeinate}, Windows's {@code SetThreadExecutionState}, nor systemd's
 * inhibitor locks can override a user-initiated sleep, a lid close, or a
 * critical-battery shutdown — that is a platform guarantee, not a gap here.
 *
 * <h3>Threading contract</h3>
 * {@link #engage()} and {@link #disengage()} are always invoked from
 * {@link KeepAwakeService}'s single worker thread, never concurrently. This is
 * load-bearing on Windows, where the execution state is owned by the calling
 * thread and is cleared by the OS the moment that thread dies — acquiring and
 * releasing from a pooled thread would silently drop the request.
 */
interface SleepInhibitor {

    /** Start suppressing idle sleep. Must be a no-op when already engaged. */
    void engage();

    /** Stop suppressing idle sleep. Must be a no-op when not engaged. */
    void disengage();

    /** Human-readable mechanism name, for the IDE log. */
    String describe();
}
