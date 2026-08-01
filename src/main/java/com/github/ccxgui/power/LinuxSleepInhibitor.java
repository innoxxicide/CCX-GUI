package com.github.ccxgui.power;

import java.util.Arrays;
import java.util.List;

/**
 * Linux backend built on {@code systemd-inhibit}, which is what desktop
 * environments themselves consult before idling a session.
 *
 * <p>The helper command is {@code cat}, chosen for the orphan guard demanded by
 * {@link ProcessSleepInhibitor}: it inherits the IDE's end of the stdin pipe, so
 * when the IDE dies the pipe closes, {@code cat} reads EOF and exits, and systemd
 * drops the lock. Without that, a killed IDE would leave the session permanently
 * un-idleable.
 *
 * <p>On a machine without systemd the spawn fails with {@code IOException} and
 * the base class degrades to "sleep is not inhibited". A {@code block} lock on
 * {@code sleep} can also be refused by polkit; that surfaces as an immediate
 * non-zero exit, which the base class logs.
 */
final class LinuxSleepInhibitor extends ProcessSleepInhibitor {

    @Override
    protected List<String> command() {
        return Arrays.asList(
                "systemd-inhibit",
                "--what=idle:sleep",
                "--who=CCX GUI",
                "--why=AI agent is working",
                "--mode=block",
                "cat");
    }

    @Override
    public String describe() {
        return "systemd-inhibit --what=idle:sleep (Linux)";
    }
}
