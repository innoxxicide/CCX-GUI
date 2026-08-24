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

    /**
     * Verifies Claude context usage includes all input-side cache categories but excludes output.
     */
    @Test
    public void contextTokensExcludeOutputTokens() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("cache_creation_input_tokens", 12000);
        usage.addProperty("cache_read_input_tokens", 160000);
        usage.addProperty("output_tokens", 2400);

        Assert.assertEquals(352000, TokenUsageUtils.extractContextTokens(usage, "claude"));
    }

    /**
     * Verifies Codex context usage uses the provider's cache-inclusive input count only.
     */
    @Test
    public void codexContextTokensUseInputOnly() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("output_tokens", 2400);
        usage.addProperty("cached_input_tokens", 160000);

        Assert.assertEquals(180000, TokenUsageUtils.extractContextTokens(usage, "codex"));
    }

    /**
     * Verifies Codex lookup prefers the root current-context snapshot over nested historical usage.
     */
    @Test
    public void codexPrefersTopLevelContextUsageOverNestedHistoricalUsage() {
        JsonObject nestedUsage = new JsonObject();
        nestedUsage.addProperty("input_tokens", 22496533);
        JsonObject message = new JsonObject();
        message.add("usage", nestedUsage);

        JsonObject currentUsage = new JsonObject();
        currentUsage.addProperty("input_tokens", 127886);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        raw.add("usage", currentUsage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT,
                "",
                raw
        );

        Assert.assertEquals(
                127886,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant), "codex")
                        .get("input_tokens").getAsInt()
        );
        Assert.assertEquals(
                22496533,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant))
                        .get("input_tokens").getAsInt()
        );
    }

    /**
     * Verifies a provider-reported context window overrides static configuration while malformed
     * or missing metadata retains the supplied fallback.
     */
    @Test
    public void extractMaxTokensPrefersTrustedProviderWindow() {
        JsonObject usage = new JsonObject();
        usage.addProperty("model_context_window", 258400);

        Assert.assertEquals(258400, TokenUsageUtils.extractMaxTokens(usage, 1_050_000));
        usage.addProperty("model_context_window", -1);
        Assert.assertEquals(1_050_000, TokenUsageUtils.extractMaxTokens(usage, 1_050_000));
        Assert.assertEquals(0, TokenUsageUtils.extractMaxTokens(null, -1));
    }

    /**
     * Verifies selection changes remove both supported context usage locations without
     * deleting historical per-turn usage or cost metadata.
     */
    @Test
    public void clearContextUsagePreservesTurnAccounting() {
        JsonObject raw = new JsonObject();
        raw.add("usage", inputUsage(12000));
        raw.add("turnUsage", inputUsage(345));
        raw.addProperty("turnCostUsd", 0.42);
        JsonObject nestedMessage = new JsonObject();
        nestedMessage.add("usage", inputUsage(9000));
        raw.add("message", nestedMessage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "answer", raw);

        TokenUsageUtils.clearContextUsageFromSessionMessages(List.of(assistant));

        Assert.assertFalse(raw.has("usage"));
        Assert.assertFalse(nestedMessage.has("usage"));
        Assert.assertTrue(raw.has("turnUsage"));
        Assert.assertTrue(raw.has("turnCostUsd"));
    }

    private static JsonObject inputUsage(int inputTokens) {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", inputTokens);
        return usage;
    }
}
