package com.github.ccxgui.handler;

import com.github.ccxgui.handler.core.BaseMessageHandler;
import com.github.ccxgui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Puts the session shown in this panel under Claude Remote Control, so the same
 * conversation can be driven from claude.ai, and takes it back off on request.
 * Only the Claude provider has the control request behind this; the others answer
 * with an explicit refusal instead of pretending the switch flipped.
 */
public class RemoteControlHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(RemoteControlHandler.class);

    private static final String[] SUPPORTED_TYPES = {"set_remote_control"};

    private final Gson gson = new Gson();

    public RemoteControlHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"set_remote_control".equals(type)) {
            return false;
        }
        handleSetRemoteControl(content);
        return true;
    }

    /**
     * A request the webview sent: whether to expose the session and under which
     * display name. An unreadable body means "expose it" — the button only ever
     * asks for the off state after a confirmed on.
     */
    static class RemoteControlRequest {
        final boolean enabled;
        final String name;

        RemoteControlRequest(boolean enabled, String name) {
            this.enabled = enabled;
            this.name = name;
        }
    }

    static RemoteControlRequest parseRemoteControlRequest(Gson gson, String content) {
        boolean enabled = true;
        String name = null;
        try {
            if (content != null && !content.isEmpty()) {
                JsonObject request = gson.fromJson(content, JsonObject.class);
                if (request != null) {
                    if (request.has("enabled") && !request.get("enabled").isJsonNull()) {
                        enabled = request.get("enabled").getAsBoolean();
                    }
                    if (request.has("name") && !request.get("name").isJsonNull()) {
                        name = request.get("name").getAsString();
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[RemoteControlHandler] Malformed request, falling back to enable: " + e.getMessage());
        }
        return new RemoteControlRequest(enabled, name);
    }

    private void handleSetRemoteControl(String content) {
        RemoteControlRequest request = parseRemoteControlRequest(this.gson, content);
        final boolean requestedEnabled = request.enabled;
        final String requestedName = request.name;

        String provider = this.context.getCurrentProvider();
        if (provider == null || provider.isEmpty()) {
            provider = HandlerContext.DEFAULT_PROVIDER;
        }
        if (!"claude".equals(provider)) {
            sendResult(false, requestedEnabled, "Remote Control is available for the Claude provider only");
            return;
        }

        com.github.ccxgui.session.ClaudeSession session = this.context.getSession();
        if (session == null) {
            sendResult(false, requestedEnabled, "No active session to hand over");
            return;
        }

        String sessionId = session.getSessionId();
        String cwd = session.getCwd();

        try {
            this.context.getClaudeSDKBridge()
                    .setRemoteControl(sessionId, cwd, requestedEnabled, requestedName)
                    .thenAccept(result -> {
                        boolean ok = result != null && result.has("success") && result.get("success").getAsBoolean();
                        if (ok) {
                            sendResult(true, requestedEnabled, null);
                            return;
                        }
                        String error = "Remote Control request failed";
                        if (result != null && result.has("error") && !result.get("error").isJsonNull()) {
                            String reported = result.get("error").getAsString();
                            if (!reported.isEmpty()) {
                                error = reported;
                            }
                        }
                        LOG.warn("[RemoteControlHandler] " + error);
                        sendResult(false, requestedEnabled, error);
                    })
                    .exceptionally(ex -> {
                        LOG.error("[RemoteControlHandler] setRemoteControl failed", ex);
                        sendResult(false, requestedEnabled, ex.getMessage());
                        return null;
                    });
        } catch (Exception e) {
            LOG.error("[RemoteControlHandler] Unexpected error", e);
            sendResult(false, requestedEnabled, e.getMessage());
        }
    }

    private void sendResult(boolean success, boolean enabled, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", success);
        payload.addProperty("enabled", success && enabled);
        if (error != null && !error.isEmpty()) {
            payload.addProperty("error", error);
        }
        String json = this.gson.toJson(payload);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.onRemoteControlResult", escapeJs(json));
        });
    }
}
