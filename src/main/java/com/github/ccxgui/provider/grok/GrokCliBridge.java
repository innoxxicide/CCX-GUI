package com.github.ccxgui.provider.grok;

import com.github.ccxgui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Grok CLI bridge.
 *
 * <p>Grok has no official SDK. This bridge launches {@code channel-manager.js}
 * with provider {@code grok}, which spawns the local Grok CLI and maps
 * streaming-json NDJSON onto the shared marker protocol.
 */
public class GrokCliBridge extends MarkerCliBridge {

    public GrokCliBridge() {
        super(GrokCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "grok";
    }

    @Override
    protected String getStdinEnvKey() {
        return "GROK_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        env.put("GROK_DISABLE_AUTOUPDATER", "1");
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new GrokHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
