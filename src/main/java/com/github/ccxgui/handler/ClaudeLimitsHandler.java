package com.github.ccxgui.handler;

import com.github.ccxgui.handler.core.BaseMessageHandler;
import com.github.ccxgui.handler.core.HandlerContext;
import com.github.ccxgui.provider.claude.ClaudeSDKBridge;
import com.github.ccxgui.provider.claude.ClaudeUsageLimitsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Handles webview requests for the signed-in Claude account's usage limits
 * (5-hour session + weekly windows). Serves the pull path: initial load,
 * manual refresh, and opening the usage-statistics modal. The push-on-agent
 * path lives in {@code ClaudeMessageHandler#handleUsage}.
 */
public class ClaudeLimitsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClaudeLimitsHandler.class);
    private static final String GET_CLAUDE_LIMITS = "get_claude_limits";
    private static final String[] SUPPORTED_TYPES = { GET_CLAUDE_LIMITS };

    public ClaudeLimitsHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!GET_CLAUDE_LIMITS.equals(type)) {
            return false;
        }
        handleGetClaudeLimits(content);
        return true;
    }

    private void handleGetClaudeLimits(String content) {
        String provider = context.getCurrentProvider();
        if (provider != null && !"claude".equalsIgnoreCase(provider)) {
            // Usage limits only apply to Claude; the webview hides the indicators
            // for other providers, so there is nothing to push here.
            return;
        }
        boolean force = "force".equals(content);
        ClaudeSDKBridge bridge = context.getClaudeSDKBridge();

        // Idle pull path (initial load / manual refresh / opening the modal).
        // Unlike the push path (ClaudeMessageHandler#handleUsage), which fires
        // during agent activity when the SDK has just refreshed the OAuth token,
        // here the access token may have expired with nothing to renew it. When
        // it is stale, delegate the refresh to the daemon's SDK — the official
        // CLI owns refresh-token rotation and the write-back to the credentials
        // file — then fetch fresh with the renewed token. We never write
        // credentials or call the OAuth token endpoint ourselves.
        //
        // The staleness check reads the credentials store, which can touch the
        // macOS Keychain, so it runs off the caller thread.
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            if (bridge != null && ClaudeUsageLimitsService.isAccessTokenStale()) {
                bridge.refreshAuthAsync().whenComplete((refreshed, ex) -> fetchAndPush(true));
            } else {
                fetchAndPush(force);
            }
        });
    }

    private void fetchAndPush(boolean force) {
        ClaudeUsageLimitsService.getOrFetch(force).thenAccept(json -> {
            if (json != null) {
                context.callJavaScript("onClaudeLimitsUpdate", context.escapeJs(json));
            }
        }).exceptionally(ex -> {
            LOG.warn("[ClaudeLimitsHandler] Failed to resolve usage limits: " + ex.getMessage());
            return null;
        });
    }
}
