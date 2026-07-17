package com.github.ccxgui.provider.claude;

import com.github.ccxgui.settings.CodemossSettingsService;
import com.github.ccxgui.settings.PermissionDialogTimeoutSettings;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.nio.charset.StandardCharsets;

/**
 * Shared utility methods used across Claude bridge classes.
 * Eliminates duplication of common operations like env construction,
 * working directory resolution, and stdin writing.
 */
final class ClaudeBridgeUtils {

    private ClaudeBridgeUtils() {
    }

    /**
     * Build the environment variables block sent to the daemon process.
     * Used by both {@link ClaudeDaemonCoordinator} and {@link ClaudeDaemonRequestExecutor}.
     */
    static JsonObject buildDaemonEnv(String cwd) {
        JsonObject envVars = new JsonObject();
        envVars.addProperty("CLAUDE_USE_STDIN", "true");
        if (isValidCwd(cwd)) {
            envVars.addProperty("IDEA_PROJECT_PATH", cwd);
            envVars.addProperty("PROJECT_PATH", cwd);
        }
        // Send the safety-net budget per request, not just at daemon spawn. The daemon is a
        // long-running pooled process, so a mid-session toggle of "auto-close on timeout" would
        // otherwise never reach it. 0 = "wait indefinitely": the AskUserQuestion / permission IPC
        // poll then blocks until the user answers instead of returning null after the default ~6 min.
        envVars.addProperty("CLAUDE_PERMISSION_SAFETY_NET_MS",
                String.valueOf(resolvePermissionSafetyNetMs()));
        return envVars;
    }

    private static long resolvePermissionSafetyNetMs() {
        try {
            return PermissionDialogTimeoutSettings.resolvePermissionSafetyNetMs(new CodemossSettingsService());
        } catch (Exception e) {
            // Fall back to DEFAULT + buffer (not the 0 sentinel): a transient settings-read failure
            // must not silently switch every request into indefinite-wait mode.
            return (CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        }
    }

    /**
     * Resolve the effective working directory for a Node.js process.
     * Prefers the user-supplied {@code cwd} when it exists and is a directory;
     * falls back to {@code defaultDir} otherwise.
     */
    static File resolveWorkingDirectory(File defaultDir, String cwd) {
        if (isValidCwd(cwd)) {
            File userWorkDir = new File(cwd);
            if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                return userWorkDir;
            }
        }
        return defaultDir;
    }

    /**
     * Write a JSON payload to the stdin of a child process, then close the stream.
     * Failures are silently ignored (the process will fail to read stdin and exit).
     */
    static void writeStdin(String stdinJson, Process process) {
        writeStdin(stdinJson, process, null, null);
    }

    /**
     * Write a JSON payload to the stdin of a child process with optional logging on failure.
     */
    static void writeStdin(String stdinJson, Process process, Logger log, String logPrefix) {
        try (java.io.OutputStream stdin = process.getOutputStream()) {
            stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        } catch (Exception e) {
            if (log != null && logPrefix != null) {
                log.warn(logPrefix + " Failed to write stdin: " + e.getMessage());
            }
        }
    }

    private static boolean isValidCwd(String cwd) {
        return cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd);
    }
}
