package com.github.ccxgui.power;

import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Shared lifecycle for the Unix backends, which both hold the inhibitor for as
 * long as a helper process stays alive: engaging spawns it, disengaging kills it.
 *
 * <p>Each subclass is additionally responsible for making its helper die on its
 * own if the IDE is killed without ever calling {@link #disengage()} — an orphan
 * here would keep the machine awake indefinitely, with no UI left to explain why.
 *
 * <p>All state is confined to {@link KeepAwakeService}'s worker thread; see the
 * threading contract on {@link SleepInhibitor}.
 */
abstract class ProcessSleepInhibitor implements SleepInhibitor {

    private static final Logger LOG = Logger.getInstance(ProcessSleepInhibitor.class);

    /** How long to wait for a well-behaved helper to exit before forcing it. */
    private static final long TERMINATION_TIMEOUT_SECONDS = 2L;

    /** Volatile only because {@link #watchForUnexpectedExit} reads it from the process-reaper thread. */
    private volatile Process process;

    /** The helper command line, rebuilt on every engage. */
    protected abstract List<String> command();

    @Override
    public void engage() {
        if (process != null && process.isAlive()) {
            return;
        }
        List<String> command = command();
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            // stdin stays a pipe on purpose: the Linux helper uses EOF on it as its
            // "the IDE is gone, release the lock" signal.
            builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            builder.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process started = builder.start();
            process = started;
            watchForUnexpectedExit(started, command);
            LOG.info("[KeepAwake] Started helper: " + String.join(" ", command));
        } catch (IOException e) {
            // The helper is missing (no systemd, stripped-down image, …). Log once
            // per attempt and carry on without inhibiting.
            process = null;
            LOG.warn("[KeepAwake] Could not start helper " + String.join(" ", command) + ": " + e.getMessage());
        }
    }

    @Override
    public void disengage() {
        Process current = process;
        process = null;
        if (current == null) {
            return;
        }
        current.destroy();
        try {
            if (!current.waitFor(TERMINATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                current.destroyForcibly();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            current.destroyForcibly();
        }
    }

    /**
     * Report a helper that dies on its own — a refused polkit lock, a killed
     * process — so the log explains why sleep was never actually inhibited.
     *
     * <p>{@link #disengage()} clears {@link #process} <em>before</em> killing the
     * helper, so the identity check below is what distinguishes an intentional
     * teardown (silent) from a spontaneous death (logged).
     */
    private void watchForUnexpectedExit(Process started, List<String> command) {
        started.onExit().thenAccept(exited -> {
            if (process == started) {
                LOG.warn("[KeepAwake] Helper exited unexpectedly with code " + exited.exitValue()
                        + "; sleep is no longer inhibited: " + String.join(" ", command));
            }
        });
    }
}
