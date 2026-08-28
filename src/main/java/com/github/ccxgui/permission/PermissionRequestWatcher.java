package com.github.ccxgui.permission;

import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;

/**
 * Polls the permission directory and dispatches session-scoped request files.
 */
class PermissionRequestWatcher {

    interface RequestHandler {
        void handlePermissionRequest(Path requestFile);

        void handleAskUserQuestionRequest(Path requestFile);

        void handlePlanApprovalRequest(Path requestFile);
    }

    private static final Logger LOG = Logger.getInstance(PermissionRequestWatcher.class);
    private static final int POLL_INTERVAL_MS = 500;
    private static final int ERROR_RETRY_DELAY_MS = 1000;
    /**
     * On start, only purge session IPC files older than this. Fresh requests that
     * Node may have written just before a watcher restart must survive so they
     * can still be consumed (AskUserQuestion / permission hang regression).
     */
    static final long STALE_SESSION_FILE_MAX_AGE_MS = TimeUnit.HOURS.toMillis(2);

    private final Path permissionDir;
    private final String sessionId;
    private final PermissionFileProtocol fileProtocol;
    private final BiConsumer<String, String> debugLog;

    private volatile boolean running;
    // Volatile because an outgoing watch thread reads it to check whether it is still the
    // owner before clearing `running` — see watchLoop's finally block.
    private volatile Thread watchThread;

    PermissionRequestWatcher(
            Path permissionDir,
            String sessionId,
            PermissionFileProtocol fileProtocol,
            BiConsumer<String, String> debugLog
    ) {
        this.permissionDir = permissionDir;
        this.sessionId = sessionId;
        this.fileProtocol = fileProtocol;
        this.debugLog = debugLog;
    }

    void start(RequestHandler handler) {
        if (running) {
            debugLog.accept("START", "Already running, skipping start");
            return;
        }

        // Stale-only cleanup: never wipe an in-flight request created moments ago.
        fileProtocol.cleanupStaleSessionFiles(STALE_SESSION_FILE_MAX_AGE_MS);
        running = true;
        watchThread = new Thread(() -> watchLoop(handler), "PermissionWatcher-" + sessionId);
        watchThread.setDaemon(true);
        watchThread.start();

        debugLog.accept("START", "Started polling on: " + permissionDir);
    }

    void stop() {
        running = false;
        if (watchThread != null) {
            watchThread.interrupt();
            try {
                watchThread.join(1000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                LOG.error("Error occurred", e);
            }
        }
    }

    private void watchLoop(RequestHandler handler) {
        debugLog.accept("WATCH_LOOP", "Starting polling loop on: " + permissionDir);
        try {
            pollUntilStopped(handler);
        } finally {
            // Clearing the flag here (rather than only in stop()) is what makes the
            // watcher restartable. If this thread ever dies while `running` is still
            // true — a spurious interrupt, an Error escaping the loop body — start()
            // would take its "Already running" early return forever, and every later
            // permission request in this session would sit unread in the IPC directory:
            // no dialog, and the agent blocked until the Node safety net fires (never,
            // when "auto-close dialog on timeout" is off).
            //
            // Only the current owner may clear it: stop() gives up joining after 1s, so a
            // slow thread can still be unwinding when start() has already installed its
            // successor, and clearing the flag then would switch that successor off.
            if (watchThread == Thread.currentThread()) {
                running = false;
            }
            debugLog.accept("WATCH_LOOP", "Polling loop ended");
        }
    }

    private void pollUntilStopped(RequestHandler handler) {
        int pollCount = 0;
        while (running) {
            try {
                pollCount++;
                File dir = permissionDir.toFile();
                if (!dir.exists()) {
                    dir.mkdirs();
                }

                File[] requestFiles = fileProtocol.listPermissionRequestFiles();
                File[] askUserQuestionFiles = fileProtocol.listAskUserQuestionRequestFiles();
                File[] planApprovalFiles = fileProtocol.listPlanApprovalRequestFiles();

                if (pollCount % 100 == 0) {
                    debugLog.accept("POLL_STATUS", String.format(
                            "Poll #%d, found %d request files, %d ask-user-question files, %d plan-approval files",
                            pollCount,
                            requestFiles.length,
                            askUserQuestionFiles.length,
                            planApprovalFiles.length
                    ));
                }

                dispatchFiles(requestFiles, "REQUEST_FOUND", handler::handlePermissionRequest);
                dispatchFiles(askUserQuestionFiles, "ASK_USER_QUESTION_FOUND", handler::handleAskUserQuestionRequest);
                dispatchFiles(planApprovalFiles, "PLAN_APPROVAL_FOUND", handler::handlePlanApprovalRequest);

                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                if (!keepPollingAfterInterrupt()) {
                    return;
                }
            } catch (Throwable e) {
                // Throwable, not Exception: an Error escaping a request handler used to
                // kill this thread outright and silently stop all permission routing.
                if (!recoverFromPollError(e)) {
                    return;
                }
            }
        }
    }

    /**
     * Report a failed poll and back off before the next one.
     *
     * @return true to continue polling, false to exit
     */
    private boolean recoverFromPollError(Throwable error) {
        try {
            debugLog.accept("POLL_ERROR", "Error in poll loop: " + error.getMessage());
            LOG.error("Error occurred", error);
        } catch (Throwable reportingFailure) {
            // Reporting must not be able to kill the poll loop: Logger.error rethrows what it
            // is handed under the test logger and in IDE internal mode, which would defeat the
            // whole point of catching Throwable above.
        }
        try {
            Thread.sleep(ERROR_RETRY_DELAY_MS);
        } catch (InterruptedException e) {
            return keepPollingAfterInterrupt();
        }
        return true;
    }

    /**
     * Decide whether an interrupt means "shut down" or "spurious, keep polling".
     *
     * <p>{@link #stop()} clears {@code running} before interrupting, so a real stop is
     * already visible here. Any other interrupt (the IDE cancelling work on a pooled
     * thread, a handler restoring the interrupt flag after swallowing it) must not end
     * polling: the loop would exit while the session is still live and every subsequent
     * permission request would go unanswered.</p>
     *
     * @return true to continue polling, false to exit and propagate the interrupt
     */
    private boolean keepPollingAfterInterrupt() {
        if (!running) {
            Thread.currentThread().interrupt();
            return false;
        }
        // Clear the interrupt status so the next Thread.sleep() does not rethrow immediately.
        Thread.interrupted();
        debugLog.accept("POLL_INTERRUPTED", "Spurious interrupt while still running; continuing to poll");
        return true;
    }

    private void dispatchFiles(File[] files, String tag, java.util.function.Consumer<Path> consumer) {
        for (File file : files) {
            if (!file.exists()) {
                continue;
            }
            debugLog.accept(tag, "Found request file: " + file.getName());
            consumer.accept(file.toPath());
        }
    }
}
