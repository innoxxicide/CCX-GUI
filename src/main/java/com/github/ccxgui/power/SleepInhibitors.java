package com.github.ccxgui.power;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;

/**
 * Chooses the {@link SleepInhibitor} backend for the running OS.
 *
 * <p>An unrecognised platform gets the no-op backend rather than an error: the
 * keep-awake toggle is a convenience, and a platform we cannot serve should
 * behave exactly like the toggle being off.
 */
final class SleepInhibitors {

    private static final Logger LOG = Logger.getInstance(SleepInhibitors.class);

    private SleepInhibitors() {
    }

    static SleepInhibitor forCurrentPlatform() {
        if (SystemInfo.isWindows) {
            return new WindowsSleepInhibitor();
        }
        if (SystemInfo.isMac) {
            return new MacSleepInhibitor();
        }
        if (SystemInfo.isLinux) {
            return new LinuxSleepInhibitor();
        }
        LOG.info("[KeepAwake] No sleep-inhibit backend for this platform; the setting will have no effect.");
        return new NoopSleepInhibitor();
    }

    /** Backend for platforms with no supported mechanism. */
    static final class NoopSleepInhibitor implements SleepInhibitor {

        @Override
        public void engage() {
        }

        @Override
        public void disengage() {
        }

        @Override
        public String describe() {
            return "unsupported platform (no-op)";
        }
    }
}
