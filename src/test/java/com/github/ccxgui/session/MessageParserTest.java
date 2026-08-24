package com.github.ccxgui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class MessageParserTest {

    @Test
    public void parseServerMessageKeepsUserMessageWithOnlyImageBlocks() {
        MessageParser parser = new MessageParser();

        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");
        imageBlock.addProperty("src", "data:image/png;base64,abc123");

        JsonArray content = new JsonArray();
        content.add(imageBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);

        ClaudeSession.Message parsed = parser.parseServerMessage(raw);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.USER, parsed.type);
        assertEquals("", parsed.content);
        assertEquals(raw, parsed.raw);
    }

    @Test
    public void parseServerMessageUnwrapsNormalizedToolUseRawPayload() {
        MessageParser parser = new MessageParser();

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", "call-1");
        toolUse.addProperty("name", "glob");
        JsonObject input = new JsonObject();
        input.addProperty("command", "rg TODO");
        toolUse.add("input", input);

        JsonArray content = new JsonArray();
        content.add(toolUse);

        JsonObject normalizedRaw = new JsonObject();
        normalizedRaw.add("content", content);
        normalizedRaw.addProperty("role", "assistant");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("content", "Tool: glob");
        envelope.add("raw", normalizedRaw);

        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, parsed.type);
        assertEquals("Tool: glob", parsed.content);
        assertEquals(normalizedRaw, parsed.raw);
        assertFalse(parsed.raw.has("raw"));
        assertEquals("tool_use", parsed.raw.getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void parseServerMessageKeepsNormalizedImageOnlyMessage() {
        MessageParser parser = new MessageParser();

        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");
        imageBlock.addProperty("src", "data:image/png;base64,abc123");

        JsonArray content = new JsonArray();
        content.add(imageBlock);

        JsonObject normalizedRaw = new JsonObject();
        normalizedRaw.add("content", content);
        normalizedRaw.addProperty("role", "user");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "user");
        envelope.addProperty("content", "");
        envelope.add("raw", normalizedRaw);

        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.USER, parsed.type);
        assertEquals("", parsed.content);
        assertEquals(normalizedRaw, parsed.raw);
    }

    @Test
    public void parseServerMessageRestoresSyntheticApiErrorAsAnError() {
        // Claude Code records a usage-limit stop as a synthetic assistant message,
        // not as a failed turn. Restoring it as plain assistant text makes a stop
        // the user must act on read like something the agent chose to say.
        MessageParser parser = new MessageParser();
        String notice = "You've hit your session limit · resets 3pm (Europe/Kiev)";

        ClaudeSession.Message parsed = parser.parseServerMessage(syntheticLimitRecord(notice));

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.ERROR, parsed.type);
        assertEquals(notice, parsed.content);
    }

    @Test
    public void parseServerMessageRestoresSyntheticApiErrorFromNormalizedEnvelope() {
        MessageParser parser = new MessageParser();
        String notice = "You've hit your session limit · resets 3pm (Europe/Kiev)";

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("content", notice);
        envelope.add("raw", syntheticLimitRecord(notice));

        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.ERROR, parsed.type);
    }

    @Test
    public void parseServerMessageKeepsOrdinaryAssistantMessagesAsAssistant() {
        MessageParser parser = new MessageParser();

        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", "Done — three files changed.");

        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);

        ClaudeSession.Message parsed = parser.parseServerMessage(raw);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, parsed.type);
    }

    @Test
    public void parseServerMessageDropsNoResponseRequestedAssistantPlaceholder() {
        MessageParser parser = new MessageParser();

        JsonObject contentBlock = new JsonObject();
        contentBlock.addProperty("type", "text");
        contentBlock.addProperty("text", "No response requested.");

        JsonArray content = new JsonArray();
        content.add(contentBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);

        assertNull(parser.parseServerMessage(raw));
    }

    /** The shape Claude Code writes to JSONL when an API error ends a turn. */
    private static JsonObject syntheticLimitRecord(String notice) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", notice);

        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject message = new JsonObject();
        message.addProperty("model", "<synthetic>");
        message.addProperty("role", "assistant");
        message.addProperty("stop_reason", "stop_sequence");
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.addProperty("error", "rate_limit");
        raw.addProperty("isApiErrorMessage", true);
        raw.add("message", message);
        return raw;
    }
}
