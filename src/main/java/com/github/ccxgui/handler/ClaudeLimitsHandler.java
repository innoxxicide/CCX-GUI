package com.github.ccxgui.handler;

import com.github.ccxgui.handler.core.BaseMessageHandler;
import com.github.ccxgui.handler.core.HandlerContext;
import com.github.ccxgui.provider.claude.ClaudeUsageLimitsService;
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
