package com.github.ccxgui.util;

import com.github.ccxgui.session.ClaudeSession;
import com.google.gson.JsonObject;
import org.junit.Assert;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * Unit tests for {@link TokenUsageUtils}, focused on excluding subagent
 * (sidechain) messages from the main-session context gauge. Subagent messages
 * stream inline tagged with parent_tool_use_id and run in a separate, much
 * smaller context window; counting them made the gauge lurch down and rebound.
 */
public class TokenUsageUtilsTest {

    private static JsonObject usage(int input, int cacheRead, int output) {
        JsonObject u = new JsonObject();
        u.addProperty("input_tokens", input);
        u.addProperty("cache_read_input_tokens", cacheRead);
        u.addProperty("output_tokens", output);
        return u;
    }

    private static JsonObject assistantRaw(JsonObject usage, String parentToolUseId) {
        JsonObject message = new JsonObject();
        message.add("usage", usage);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);
        if (parentToolUseId == null) {
            raw.add("parent_tool_use_id", com.google.gson.JsonNull.INSTANCE);
        } else {
            raw.addProperty("parent_tool_use_id", parentToolUseId);
        }
        return raw;
    }

    @Test
    public void extractUsedTokens_claudeSumsInputCacheAndOutput() {
        Assert.assertEquals(60105, TokenUsageUtils.extractUsedTokens(usage(100, 60000, 5), "claude"));
    }

    @Test
    public void extractUsedTokens_codexIgnoresCacheFields() {
        Assert.assertEquals(105, TokenUsageUtils.extractUsedTokens(usage(100, 60000, 5), "codex"));
    }

    @Test
    public void findLastUsageFromSessionMessages_skipsSubagentMessage() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        // Main-chain assistant with a large context.
        messages.add(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "", assistantRaw(usage(100, 60000, 5), null)));
        // Subagent assistant arriving later with a small, fresh context.
        messages.add(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "", assistantRaw(usage(200, 8000, 10), "toolu_task_1")));

        JsonObject last = TokenUsageUtils.findLastUsageFromSessionMessages(messages);
        Assert.assertNotNull(last);
        // Must return the main-chain usage, not the trailing subagent's.
        Assert.assertEquals(60000, last.get("cache_read_input_tokens").getAsInt());
    }

    @Test
    public void findLastUsageFromRawMessages_skipsSubagentMessage() {
        List<JsonObject> messages = new ArrayList<>();
        messages.add(assistantRaw(usage(100, 60000, 5), null));
        messages.add(assistantRaw(usage(200, 8000, 10), "toolu_task_1"));

        JsonObject last = TokenUsageUtils.findLastUsageFromRawMessages(messages);
        Assert.assertNotNull(last);
        Assert.assertEquals(60000, last.get("cache_read_input_tokens").getAsInt());
    }

    @Test
    public void findLastUsageFromSessionMessages_returnsNullWhenOnlySubagentMessages() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "", assistantRaw(usage(200, 8000, 10), "toolu_task_1")));

        Assert.assertNull(TokenUsageUtils.findLastUsageFromSessionMessages(messages));
    }
}
