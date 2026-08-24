package com.github.ccxgui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Resolves and converts one Codex subagent turn from local rollout files.
 */
final class CodexSubagentHistoryLoader {

    private static final Logger LOG = Logger.getInstance(CodexSubagentHistoryLoader.class);
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]+");
    private static final Pattern SAFE_AGENT_PATH =
            Pattern.compile("/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*");
    private static final int MAX_CACHE_ENTRIES = 256;

    private final Path sessionsDir;
    private final Map<LookupKey, Location> locationCache =
            Collections.synchronizedMap(new LinkedHashMap<LookupKey, Location>(32, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<LookupKey, Location> eldest) {
                    return size() > MAX_CACHE_ENTRIES;
                }
            });

    CodexSubagentHistoryLoader(Path sessionsDir) {
        this.sessionsDir = sessionsDir;
    }

    Result load(String parentSessionId, String toolUseId, String requestedAgentPath) throws IOException {
        validateId("sessionId", parentSessionId);
        if (toolUseId != null && !toolUseId.isBlank()) {
            validateId("toolUseId", toolUseId);
        }
        if (requestedAgentPath != null && !requestedAgentPath.isBlank()) {
            validateAgentPath(requestedAgentPath);
        }
        if ((toolUseId == null || toolUseId.isBlank())
                && (requestedAgentPath == null || requestedAgentPath.isBlank())) {
            throw new IllegalArgumentException("Missing toolUseId and agentPath");
        }

        LookupKey key = new LookupKey("codex", parentSessionId, toolUseId, requestedAgentPath);
        Location location = locationCache.get(key);
        if (location == null || !Files.isRegularFile(location.file())) {
            location = resolveLocation(parentSessionId, toolUseId, requestedAgentPath);
            locationCache.put(key, location);
        }

        JsonArray rollout = readInitialSubagentRollout(location.file());
        TurnSlice turn = extractInitialSubagentTurn(rollout);
        JsonArray frontendMessages = new JsonArray();
        for (JsonObject message : HistoryMessageInjector.convertCodexMessagesToFrontendBatch(turn.messages())) {
            frontendMessages.add(message);
        }
        return new Result(
                location.agentThreadId(),
                location.agentPath(),
                frontendMessages,
                turn.status(),
                turn.error()
        );
    }

    private Location resolveLocation(
            String parentSessionId,
            String toolUseId,
            String requestedAgentPath
    ) throws IOException {
        if (toolUseId != null && !toolUseId.isBlank()) {
            Path parentFile = findExactSessionFile(parentSessionId);
            Location activityLocation = findActivityLocation(parentFile, toolUseId);
            if (activityLocation != null) {
                Path childFile = findExactSessionFile(activityLocation.agentThreadId());
                return new Location(childFile, activityLocation.agentThreadId(), activityLocation.agentPath());
            }
        }

        if (requestedAgentPath == null || requestedAgentPath.isBlank()) {
            throw new PendingException("Codex subagent activity not found yet");
        }
        return findLegacyLocation(parentSessionId, requestedAgentPath);
    }

    private Location findActivityLocation(Path parentFile, String toolUseId) throws IOException {
        Location matched = null;
        try (Stream<String> lines = Files.lines(parentFile, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                JsonObject payload = eventPayload(record, "sub_agent_activity");
                if (payload == null || !toolUseId.equals(getString(payload, "event_id"))) {
                    continue;
                }
                String threadId = getString(payload, "agent_thread_id");
                if (threadId == null || threadId.isBlank()) {
                    continue;
                }
                validateId("agentThreadId", threadId);
                String agentPath = getString(payload, "agent_path");
                if (matched != null && !matched.agentThreadId().equals(threadId)) {
                    throw new IllegalStateException("Ambiguous Codex subagent activity");
                }
                matched = new Location(null, threadId, agentPath);
            }
        }
        return matched;
    }

    private Location findLegacyLocation(String parentSessionId, String agentPath) throws IOException {
        List<Location> matches = new ArrayList<>();
        if (!Files.isDirectory(sessionsDir)) {
            throw new PendingException("Codex sessions directory not found yet");
        }
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            paths.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .forEach(path -> {
                        JsonObject meta = readSessionMeta(path);
                        if (meta == null) {
                            return;
                        }
                        String candidateParent = getParentThreadId(meta);
                        String candidatePath = getAgentPath(meta);
                        String threadId = getString(meta, "id");
                        if (parentSessionId.equals(candidateParent)
                                && matchesAgentPath(agentPath, candidatePath)
                                && threadId != null) {
                            matches.add(new Location(path, threadId, candidatePath));
                        }
                    });
        }
        if (matches.isEmpty()) {
            throw new PendingException("Codex subagent rollout not found yet");
        }
        if (matches.size() > 1) {
            throw new IllegalStateException("Ambiguous Codex subagent rollout for agentPath");
        }
        return matches.get(0);
    }

    private Path findExactSessionFile(String sessionId) throws IOException {
        if (!Files.isDirectory(sessionsDir)) {
            throw new PendingException("Codex sessions directory not found yet");
        }
        String suffix = "-" + sessionId + ".jsonl";
        List<Path> matches;
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            matches = paths.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(suffix))
                    .limit(2)
                    .toList();
        }
        if (matches.isEmpty()) {
            throw new PendingException("Codex session rollout not found yet: " + sessionId);
        }
        if (matches.size() > 1) {
            throw new IllegalStateException("Ambiguous Codex session rollout: " + sessionId);
        }
        return matches.get(0);
    }

    private JsonObject readSessionMeta(Path file) {
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                if (record == null || !"session_meta".equals(getString(record, "type"))
                        || !record.has("payload") || !record.get("payload").isJsonObject()) {
                    continue;
                }
                return record.getAsJsonObject("payload");
            }
            return null;
        } catch (IOException e) {
            LOG.debug("Failed to read Codex session metadata: " + e.getMessage());
            return null;
        }
    }

    private JsonArray readInitialSubagentRollout(Path file) throws IOException {
        JsonArray messages = new JsonArray();
        boolean afterSessionMeta = false;
        String turnId = null;
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                if (record == null) {
                    continue;
                }
                if ("session_meta".equals(getString(record, "type"))) {
                    messages = new JsonArray();
                    afterSessionMeta = true;
                    turnId = null;
                }
                if (!afterSessionMeta) {
                    continue;
                }
                messages.add(record);
                if (turnId == null && "turn_context".equals(getString(record, "type"))
                        && record.has("payload") && record.get("payload").isJsonObject()) {
                    turnId = getString(record.getAsJsonObject("payload"), "turn_id");
                    continue;
                }
                if (turnId != null && (matchesTurnEvent(record, "task_complete", turnId)
                        || matchesTurnEvent(record, "turn_aborted", turnId))) {
                    break;
                }
            }
        }
        return messages;
    }

    private static boolean matchesTurnEvent(JsonObject record, String eventType, String turnId) {
        JsonObject payload = eventPayload(record, eventType);
        return payload != null && turnId.equals(getString(payload, "turn_id"));
    }

    private JsonObject parseObject(String line) {
        try {
            JsonElement parsed = JsonParser.parseString(line);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (JsonSyntaxException e) {
            LOG.warn("Skipping malformed JSONL line in Codex subagent history: " + e.getMessage());
            return null;
        }
    }

    static TurnSlice extractInitialSubagentTurn(JsonArray rollout) {
        int sessionMetaIndex = -1;
        for (int i = 0; i < rollout.size(); i++) {
            if (rollout.get(i).isJsonObject()
                    && "session_meta".equals(getString(rollout.get(i).getAsJsonObject(), "type"))) {
                sessionMetaIndex = i;
            }
        }

        String turnId = null;
        int contextIndex = -1;
        for (int i = sessionMetaIndex + 1; i < rollout.size(); i++) {
            if (!rollout.get(i).isJsonObject()) {
                continue;
            }
            JsonObject record = rollout.get(i).getAsJsonObject();
            if (!"turn_context".equals(getString(record, "type"))
                    || !record.has("payload") || !record.get("payload").isJsonObject()) {
                continue;
            }
            turnId = getString(record.getAsJsonObject("payload"), "turn_id");
            if (turnId != null) {
                contextIndex = i;
                break;
            }
        }
        if (turnId == null) {
            throw new PendingException("Codex subagent turn context not found yet");
        }

        int startIndex = -1;
        for (int i = sessionMetaIndex + 1; i <= contextIndex; i++) {
            JsonObject payload = eventPayload(rollout.get(i), "task_started");
            if (payload != null && turnId.equals(getString(payload, "turn_id"))) {
                startIndex = i;
            }
        }
        if (startIndex < 0) {
            throw new PendingException("Codex subagent turn start not found yet");
        }

        JsonArray turnMessages = new JsonArray();
        String status = "running";
        String error = null;
        for (int i = startIndex; i < rollout.size(); i++) {
            JsonElement record = rollout.get(i);
            turnMessages.add(record.deepCopy());
            JsonObject completed = eventPayload(record, "task_complete");
            if (completed != null && turnId.equals(getString(completed, "turn_id"))) {
                status = "completed";
                break;
            }
            JsonObject aborted = eventPayload(record, "turn_aborted");
            if (aborted != null && turnId.equals(getString(aborted, "turn_id"))) {
                status = "error";
                error = "Codex subagent turn was aborted";
                break;
            }
        }
        return new TurnSlice(turnMessages, status, error);
    }

    private static JsonObject eventPayload(JsonElement element, String payloadType) {
        if (element == null || !element.isJsonObject()) {
            return null;
        }
        JsonObject record = element.getAsJsonObject();
        if (!"event_msg".equals(getString(record, "type"))
                || !record.has("payload") || !record.get("payload").isJsonObject()) {
            return null;
        }
        JsonObject payload = record.getAsJsonObject("payload");
        return payloadType.equals(getString(payload, "type")) ? payload : null;
    }

    private static String getParentThreadId(JsonObject meta) {
        String direct = getString(meta, "parent_thread_id");
        if (direct != null) {
            return direct;
        }
        JsonObject spawn = getThreadSpawn(meta);
        return spawn != null ? getString(spawn, "parent_thread_id") : null;
    }

    private static String getAgentPath(JsonObject meta) {
        String direct = getString(meta, "agent_path");
        if (direct != null) {
            return direct;
        }
        JsonObject spawn = getThreadSpawn(meta);
        return spawn != null ? getString(spawn, "agent_path") : null;
    }

    private static JsonObject getThreadSpawn(JsonObject meta) {
        if (!meta.has("source") || !meta.get("source").isJsonObject()) {
            return null;
        }
        JsonObject source = meta.getAsJsonObject("source");
        if (!source.has("subagent") || !source.get("subagent").isJsonObject()) {
            return null;
        }
        JsonObject subagent = source.getAsJsonObject("subagent");
        return subagent.has("thread_spawn") && subagent.get("thread_spawn").isJsonObject()
                ? subagent.getAsJsonObject("thread_spawn") : null;
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static void validateId(String name, String value) {
        if (value == null || value.isBlank() || !SAFE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }

    private static void validateAgentPath(String value) {
        if (value.length() > 500
                || (!SAFE_AGENT_PATH.matcher(value).matches() && !SAFE_ID.matcher(value).matches())) {
            throw new IllegalArgumentException("Invalid agentPath");
        }
    }

    private static boolean matchesAgentPath(String requested, String candidate) {
        if (candidate == null) {
            return false;
        }
        return requested.equals(candidate)
                || (!requested.startsWith("/") && candidate.endsWith("/" + requested));
    }

    record Result(
            String agentThreadId,
            String agentPath,
            JsonArray messages,
            String status,
            String error
    ) {
        boolean completed() {
            return "completed".equals(status);
        }
    }

    record TurnSlice(JsonArray messages, String status, String error) {
    }

    private record LookupKey(String provider, String parentSessionId, String toolUseId, String agentPath) {
    }

    private record Location(Path file, String agentThreadId, String agentPath) {
    }

    static final class PendingException extends IllegalStateException {
        PendingException(String message) {
            super(message);
        }
    }
}
