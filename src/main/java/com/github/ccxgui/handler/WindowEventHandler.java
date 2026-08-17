package com.github.ccxgui.handler;

import com.github.ccxgui.handler.core.BaseMessageHandler;
import com.github.ccxgui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Handles window-level events from the frontend:
 * heartbeat, tab status changes, session lifecycle signals.
 */
public class WindowEventHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(WindowEventHandler.class);
    private static final String[] SUPPORTED_TYPES = {
        "heartbeat", "tab_loading_changed", "tab_status_changed",
        "create_new_session", "frontend_ready", "refresh_slash_commands",
        "claude_auto_resume_manual",
        "schedule_send", "cancel_scheduled_send", "send_scheduled_now",
        "get_scheduled_send_status"
    };

    /**
     * Callback interface for window-level operations.
     */
    public interface Callback {
        void onHeartbeat(String content);
        void onTabLoadingChanged(boolean loading);
        void onTabStatusChanged(String status);
        void onCreateNewSession();
        void onFrontendReady();
        void onRefreshSlashCommands();
        void onManualAutoResume();

        /** Schedule the message currently in the input box for delivery at {@code fireAt} (epoch millis). */
        void onScheduleSend(String message, long fireAt);

        /** Drop the pending scheduled send. */
        void onCancelScheduledSend();

        /** Send the pending (or missed) scheduled message right now. */
        void onSendScheduledNow();

        /**
         * Re-push the current scheduled-send state. The status is otherwise only
         * pushed on change, so a webview that reloaded mid-schedule would show
         * nothing until the next transition.
         */
        void onRequestScheduledSendStatus();
    }

    private final Callback callback;

    public WindowEventHandler(HandlerContext context, Callback callback) {
        super(context);
        this.callback = callback;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "heartbeat":
                callback.onHeartbeat(content);
                return true;
            case "tab_loading_changed":
                handleTabLoadingChanged(content);
                return true;
            case "tab_status_changed":
                handleTabStatusChanged(content);
                return true;
            case "create_new_session":
                callback.onCreateNewSession();
                return true;
            case "frontend_ready":
                callback.onFrontendReady();
                return true;
            case "refresh_slash_commands":
                callback.onRefreshSlashCommands();
                return true;
            case "claude_auto_resume_manual":
                callback.onManualAutoResume();
                return true;
            case "schedule_send":
                handleScheduleSend(content);
                return true;
            case "cancel_scheduled_send":
                callback.onCancelScheduledSend();
                return true;
            case "send_scheduled_now":
                callback.onSendScheduledNow();
                return true;
            case "get_scheduled_send_status":
                callback.onRequestScheduledSendStatus();
                return true;
            default:
                return false;
        }
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    private void handleTabLoadingChanged(String content) {
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            boolean loading = json.has("loading") && json.get("loading").getAsBoolean();
            callback.onTabLoadingChanged(loading);
        } catch (Exception e) {
            LOG.warn("[TabLoading] Failed to parse loading state: " + e.getMessage());
        }
    }

    /**
     * Parse a {@code {"message": string, "fireAt": number}} payload. A malformed
     * payload is dropped rather than scheduled: the controller would reject it
     * anyway, and guessing a fire time would send the message at the wrong moment.
     */
    private void handleScheduleSend(String content) {
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            String message = json != null && json.has("message") && !json.get("message").isJsonNull()
                    ? json.get("message").getAsString()
                    : "";
            long fireAt = json != null && json.has("fireAt") && !json.get("fireAt").isJsonNull()
                    ? json.get("fireAt").getAsLong()
                    : 0L;
            callback.onScheduleSend(message, fireAt);
        } catch (Exception e) {
            LOG.warn("[ScheduledSend] Failed to parse schedule payload: " + e.getMessage());
        }
    }

    private void handleTabStatusChanged(String content) {
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            String statusStr = json.has("status") ? json.get("status").getAsString() : "idle";
            callback.onTabStatusChanged(statusStr);
        } catch (Exception e) {
            LOG.warn("[TabStatus] Failed to parse tab status: " + e.getMessage());
        }
    }
}
