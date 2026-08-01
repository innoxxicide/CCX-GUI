package com.github.ccxgui.provider.codex;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Reads Codex session metadata shared by lite and fallback history scans.
 */
final class CodexSessionMetadata {

    private CodexSessionMetadata() {
    }

    static boolean isSubagent(JsonObject payload) {
        if (payload == null || !payload.has("source")) {
            return false;
        }
        JsonElement source = payload.get("source");
        return source != null && source.isJsonObject() && source.getAsJsonObject().has("subagent");
    }

    static JsonObject findSessionMetaPayload(String head) {
        if (head == null || head.isEmpty()) {
            return null;
        }

        int start = 0;
        while (start < head.length()) {
            int newlineIndex = head.indexOf('\n', start);
            String line = newlineIndex >= 0 ? head.substring(start, newlineIndex) : head.substring(start);
            start = newlineIndex >= 0 ? newlineIndex + 1 : head.length();

            if (!line.contains("\"session_meta\"")) {
                continue;
            }

            try {
                JsonElement element = JsonParser.parseString(line);
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject message = element.getAsJsonObject();
                if (!message.has("type") || !"session_meta".equals(message.get("type").getAsString())) {
                    continue;
                }
                JsonElement payload = message.get("payload");
                return payload != null && payload.isJsonObject() ? payload.getAsJsonObject() : null;
            } catch (RuntimeException ignored) {
                // A malformed metadata line is not sufficient evidence to hide the session.
            }
        }
        return null;
    }
}
