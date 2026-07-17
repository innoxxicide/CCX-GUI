package com.github.ccxgui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;

public final class PermissionDialogTimeoutSettings {

    private static final Logger LOG = Logger.getInstance(PermissionDialogTimeoutSettings.class);

    public static final int DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS = 300;
    public static final int MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS = 30;
    public static final int MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS = 3600;
    /**
     * Buffer added on top of the user-facing dialog timeout when scheduling the Java safety net
     * and the Node IPC safety net. Kept centrally so the JVM-side safety net and the Node bridge
     * cannot drift apart.
     */
    public static final long PERMISSION_SAFETY_NET_BUFFER_SECONDS = 60L;

    /**
     * When {@code false}, no timeout applies to permission/question/plan dialogs: the countdown,
     * the JVM safety net and the Node IPC safety net are all suppressed, so a request waits
     * forever until the user answers. Defaults to {@code true} to preserve the auto-close behaviour.
     */
    public static final boolean DEFAULT_AUTO_CLOSE_DIALOG_ON_TIMEOUT = true;

    private PermissionDialogTimeoutSettings() {
    }

    public static int clampPermissionDialogTimeoutSeconds(int seconds) {
        return Math.max(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
                Math.min(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS, seconds));
    }

    public static int getPermissionDialogTimeoutSeconds(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();

        if (!config.has("permissionDialogTimeoutSeconds")) {
            return DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        }

        try {
            int timeout = config.get("permissionDialogTimeoutSeconds").getAsInt();
            return clampPermissionDialogTimeoutSeconds(timeout);
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid permissionDialogTimeoutSeconds value, rewriting default to disk; errorClass="
                    + e.getClass().getSimpleName());
            try {
                config.addProperty("permissionDialogTimeoutSeconds", DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
                service.writeConfig(config);
            } catch (IOException rewriteError) {
                LOG.warn("[CodemossSettings] Failed to self-heal permissionDialogTimeoutSeconds; errorClass="
                        + rewriteError.getClass().getSimpleName());
            }
            return DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        }
    }

    public static void setPermissionDialogTimeoutSeconds(CodemossSettingsService service, int seconds) throws IOException {
        int clamped = clampPermissionDialogTimeoutSeconds(seconds);
        JsonObject config = service.readConfig();
        config.addProperty("permissionDialogTimeoutSeconds", clamped);
        service.writeConfig(config);
    }

    public static boolean getAutoCloseDialogOnTimeout(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();

        if (!config.has("autoCloseDialogOnTimeout")) {
            return DEFAULT_AUTO_CLOSE_DIALOG_ON_TIMEOUT;
        }

        try {
            return config.get("autoCloseDialogOnTimeout").getAsBoolean();
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid autoCloseDialogOnTimeout value, rewriting default to disk; errorClass="
                    + e.getClass().getSimpleName());
            try {
                config.addProperty("autoCloseDialogOnTimeout", DEFAULT_AUTO_CLOSE_DIALOG_ON_TIMEOUT);
                service.writeConfig(config);
            } catch (IOException rewriteError) {
                LOG.warn("[CodemossSettings] Failed to self-heal autoCloseDialogOnTimeout; errorClass="
                        + rewriteError.getClass().getSimpleName());
            }
            return DEFAULT_AUTO_CLOSE_DIALOG_ON_TIMEOUT;
        }
    }

    public static void setAutoCloseDialogOnTimeout(CodemossSettingsService service, boolean enabled) throws IOException {
        JsonObject config = service.readConfig();
        config.addProperty("autoCloseDialogOnTimeout", enabled);
        service.writeConfig(config);
    }

    /**
     * Resolve the safety-net budget (ms) handed to the Node bridge via
     * {@code CLAUDE_PERMISSION_SAFETY_NET_MS}. Returns {@code 0} — the "no safety net" sentinel —
     * when auto-close is disabled, so the bridge waits indefinitely for a response instead of
     * timing the request out. Otherwise returns the user-facing timeout plus the buffer.
     */
    public static long resolvePermissionSafetyNetMs(CodemossSettingsService service) throws IOException {
        // Go through the instance accessors (not the static config readers) so callers that
        // subclass/override the settings service — e.g. unit-test fakes — are honoured.
        if (!service.getAutoCloseDialogOnTimeout()) {
            return 0L;
        }
        return (service.getPermissionDialogTimeoutSeconds() + PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
    }
}
