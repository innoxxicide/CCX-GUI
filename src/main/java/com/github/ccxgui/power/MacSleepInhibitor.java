package com.github.ccxgui.power;

import java.util.Arrays;
import java.util.List;

/**
 * macOS backend built on {@code caffeinate}, shipped with the OS since 10.8.
 *
 * <p>{@code -i} takes an idle-system-sleep assertion — the system stays up while
 * the display remains free to sleep, which is what a background agent actually
 * needs. {@code -w <pid>} is the orphan guard demanded by
 * {@link ProcessSleepInhibitor}: caffeinate exits by itself when the IDE process
 * disappears, so a hard kill cannot strand an assertion.
 */
final class MacSleepInhibitor extends ProcessSleepInhibitor {

    private static final String CAFFEINATE = "/usr/bin/caffeinate";

    @Override
    protected List<String> command() {
        return Arrays.asList(CAFFEINATE, "-i", "-w", String.valueOf(ProcessHandle.current().pid()));
    }

    @Override
    public String describe() {
        return "caffeinate -i (macOS)";
    }
}
