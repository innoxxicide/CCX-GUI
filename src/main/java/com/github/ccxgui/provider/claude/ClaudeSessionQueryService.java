package com.github.ccxgui.provider.claude;

import com.github.ccxgui.bridge.EnvironmentConfigurator;
import com.github.ccxgui.bridge.NodeDetector;
import com.github.ccxgui.bridge.ProcessManager;
import com.github.ccxgui.util.PlatformUtils;
import com.github.ccxgui.util.UserMessageSanitizer;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.function.Supplier;

/**
 * Reads persisted Claude session history via the Node bridge.
 */
class ClaudeSessionQueryService {

    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final int PROCESS_TIMEOUT_SECONDS = 30;
    /** One retry: a damaged read is transient, the bridge re-reads the same file. */
    private static final int MAX_QUERY_ATTEMPTS = 2;
    /** Cap the diagnostic tail kept for logging so a chatty bridge cannot hold megabytes. */
    private static final int MAX_DIAGNOSTIC_CHARS = 8000;
    private static final Pattern VALID_SESSION_ID = Pattern.compile("[a-zA-Z0-9_\\-]+");
    private static final Pattern IMAGE_REFERENCE_PATTERN = Pattern.compile("(?m)^\\[Image #\\d+:\\s*(.+?)\\]\\s*$");
    private static final String IMAGE_ATTACHMENT_HINT =
            "The user has attached the image(s) above. Please use the Read tool to view them.";

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeSessionQueryService(
            Logger log,
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            ProcessManager processManager,
            EnvironmentConfigurator envConfigurator,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.log = log;
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.processManager = processManager;
        this.envConfigurator = envConfigurator;
        this.outputExtractor = outputExtractor;
    }

    List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionQuery("getSession", sessionId, cwd, "getSessionMessages");

            if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                List<JsonObject> messages = new ArrayList<>();
                if (jsonResult.has("messages")) {
                    JsonArray messagesArray = jsonResult.getAsJsonArray("messages");
                    for (var msg : messagesArray) {
                        messages.add(normalizeClaudeHistoryMessage(msg.getAsJsonObject()));
                    }
                }
                return messages;
            }

            String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                    ? jsonResult.get("error").getAsString()
                    : "Unknown error";
            throw new RuntimeException("Get session failed: " + errorMsg);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
    }

    JsonObject getLatestUserMessage(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionQuery("getLatestUserMessage", sessionId, cwd, "getLatestUserMessage");

            if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                if (jsonResult.has("message") && jsonResult.get("message").isJsonObject()) {
                    return normalizeClaudeHistoryMessage(jsonResult.getAsJsonObject("message"));
                }
                return null;
            }

            String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                    ? jsonResult.get("error").getAsString()
                    : "Unknown error";
            throw new RuntimeException("Get latest user message failed: " + errorMsg);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Failed to get latest user message: " + e.getMessage(), e);
        }
    }

    /**
     * Run a bridge session query, retrying once if the process returns output the
     * JSON payload cannot be recovered from.
     *
     * <p>Only unusable-output failures are retried. Timeouts, a missing node and a
     * missing bridge directory are all deterministic, so a second 30-second attempt
     * would only double the stall.</p>
     */
    private JsonObject runSessionQuery(String commandName, String sessionId, String cwd, String logPrefix) throws Exception {
        UnusableBridgeOutputException lastFailure = null;
        for (int attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
            try {
                return runSessionQueryOnce(commandName, sessionId, cwd, logPrefix);
            } catch (UnusableBridgeOutputException e) {
                lastFailure = e;
                log.warn("[" + logPrefix + "] Attempt " + attempt + "/" + MAX_QUERY_ATTEMPTS
                        + " returned unusable output: " + e.getMessage());
            }
        }
        // Deliberately not surfacing the parser's own message: it names a JSON path
        // inside the session history and reads as data corruption, which sends anyone
        // debugging this at the session file rather than at the bridge's stdout.
        throw new RuntimeException(
                "Could not read session history: the Claude bridge returned malformed output", lastFailure);
    }

    private JsonObject runSessionQueryOnce(String commandName, String sessionId, String cwd, String logPrefix) throws Exception {
        String jsonStr = readBridgeJson(commandName, sessionId, cwd, logPrefix);
        JsonObject jsonResult;
        try {
            jsonResult = gson.fromJson(jsonStr, JsonObject.class);
        } catch (JsonSyntaxException e) {
            throw new UnusableBridgeOutputException(e.getMessage(), e);
        }
        if (jsonResult == null) {
            throw new UnusableBridgeOutputException("bridge returned an empty JSON document", null);
        }
        log.debug("[" + logPrefix + "] JSON parsed successfully, success="
                + (jsonResult.has("success") ? jsonResult.get("success").getAsBoolean() : "null"));
        return jsonResult;
    }

    private String readBridgeJson(String commandName, String sessionId, String cwd, String logPrefix) throws Exception {
        if (sessionId == null || !VALID_SESSION_ID.matcher(sessionId).matches()) {
            throw new IllegalArgumentException("Invalid sessionId: " + sessionId);
        }

        String node = nodeDetector.findNodeExecutable();

        File workDir = sdkDirSupplier.get();
        if (workDir == null || !workDir.exists()) {
            throw new RuntimeException("Bridge directory not ready or invalid");
        }

        List<String> command = NodeDetector.buildNodeScriptCommand(
                node, new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
        command.add("claude");
        command.add(commandName);
        command.add(sessionId);
        // Only translate the cwd to a WSL path when the active node is a WSL binary,
        // mirroring ClaudeSDKBridge#normalizeCwdForNode; a native node keeps the cwd as-is.
        String cwdArg = "";
        if (cwd != null) {
            cwdArg = NodeDetector.isWslPath(node) ? NodeDetector.convertToWslPath(cwd) : cwd;
        }
        command.add(cwdArg);

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(workDir);
        // Do NOT merge stderr into stdout. The bridge logs [DIAG-*] and [PERM_DEBUG]
        // diagnostics to stderr, and those lines carry raw Windows paths. Sharing one
        // pipe with the (multi-megabyte, single-line) JSON payload means a diagnostic
        // write can land inside the payload line; Gson then hits the `\U` of
        // `C:\Users\...` and dies with "Invalid escape sequence" pointing at a JSON
        // path deep inside the session history. Separate pipes make that impossible.
        pb.redirectErrorStream(false);
        envConfigurator.updateProcessEnvironment(pb, node);

        // L5 fix: register with ProcessManager so cleanupAllProcesses sees this child.
        String channelId = ProcessManager.newChannelId("claude-session-query");
        Process process = null;
        StringBuilder output = new StringBuilder();
        Thread diagnosticDrain = null;
        // StringBuffer, not StringBuilder: filled by the drain thread and read here,
        // and the join below can time out without establishing happens-before.
        StringBuffer diagnostics = new StringBuffer();
        try {
            process = pb.start();
            processManager.registerProcess(channelId, process);

            // stderr now has its own pipe, so it must have its own reader: an
            // undrained stderr pipe fills at ~64KB and blocks the child mid-payload.
            diagnosticDrain = startDiagnosticDrain(process, diagnostics);

            // Signal EOF on the child's stdin so it can never block on an unexpected read.
            try {
                process.getOutputStream().close();
            } catch (Exception ignored) {
                // best effort
            }

            // Watchdog: the child loads the SDK stack for history/usage reads and can
            // leave MCP/socket handles open so it never closes stdout. A plain
            // readLine() loop would then block forever — the previous code's waitFor
            // timeout sat AFTER the read loop and was therefore unreachable, which
            // hung the session_updated reload and leaked the process. The watchdog
            // force-terminates the process on timeout, yielding stdout EOF so the read
            // below unblocks and the caller can never hang.
            final Process startedProcess = process;
            final java.util.concurrent.atomic.AtomicBoolean timedOut =
                    new java.util.concurrent.atomic.AtomicBoolean(false);
            Thread watchdog = new Thread(() -> {
                try {
                    if (!startedProcess.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                        timedOut.set(true);
                        PlatformUtils.terminateProcess(startedProcess);
                    }
                } catch (InterruptedException ignored) {
                    // Read finished first and interrupted us; nothing to do.
                }
            }, "claude-session-query-watchdog");
            watchdog.setDaemon(true);
            watchdog.start();

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            } finally {
                watchdog.interrupt();
            }

            if (timedOut.get()) {
                throw new RuntimeException("Node.js process timed out after " + PROCESS_TIMEOUT_SECONDS + " seconds");
            }
        } finally {
            if (process != null) {
                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }
                processManager.unregisterProcess(channelId, process);
            }
            joinDiagnosticDrain(diagnosticDrain);
        }

        String outputStr = output.toString().trim();
        log.debug("[" + logPrefix + "] Raw output length: " + outputStr.length());
        if (log.isDebugEnabled()) {
            log.debug("[" + logPrefix + "] Raw output (first 300 chars): "
                    + (outputStr.length() > 300 ? outputStr.substring(0, 300) + "..." : outputStr));
        }

        String jsonStr = outputExtractor.extractLastJsonLine(outputStr);
        if (jsonStr == null) {
            log.warn("[" + logPrefix + "] No complete JSON document in bridge stdout ("
                    + outputStr.length() + " chars). Bridge diagnostics: " + diagnostics);
            throw new UnusableBridgeOutputException(
                    "no complete JSON document in bridge stdout", null);
        }

        if (log.isDebugEnabled()) {
            log.debug("[" + logPrefix + "] Extracted JSON: "
                    + (jsonStr.length() > 500 ? jsonStr.substring(0, 500) + "..." : jsonStr));
        }
        return jsonStr;
    }

    /**
     * Consume the child's stderr on its own thread, keeping a bounded head for logs.
     *
     * @param process running bridge process.
     * @param sink buffer receiving the bounded diagnostic text.
     * @return the started drain thread.
     */
    private Thread startDiagnosticDrain(Process process, StringBuffer sink) {
        Thread drain = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (sink.length() < MAX_DIAGNOSTIC_CHARS) {
                        sink.append(line).append('\n');
                    }
                    // Keep reading past the cap: stopping here would refill the pipe
                    // and block the child.
                }
            } catch (IOException e) {
                // Expected when the process is force-terminated on timeout.
                log.debug("[SessionQuery] stderr drain closed: " + e.getMessage());
            }
        }, "claude-session-query-stderr");
        drain.setDaemon(true);
        drain.start();
        return drain;
    }

    private void joinDiagnosticDrain(Thread drain) {
        if (drain == null) {
            return;
        }
        try {
            drain.join(TimeUnit.SECONDS.toMillis(2));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Raised when the bridge process ran but its stdout could not be turned into the
     * expected JSON payload. Distinct from a timeout or a configuration error because
     * only this class of failure is worth retrying.
     */
    private static final class UnusableBridgeOutputException extends RuntimeException {
        UnusableBridgeOutputException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    static JsonObject normalizeClaudeHistoryMessage(JsonObject originalMessage) {
        if (originalMessage == null
                || !originalMessage.has("type")
                || !"user".equals(originalMessage.get("type").getAsString())
                || !originalMessage.has("message")
                || !originalMessage.get("message").isJsonObject()) {
            return originalMessage;
        }

        JsonObject message = originalMessage.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return originalMessage;
        }

        JsonElement contentElement = message.get("content");
        if (contentElement.isJsonPrimitive() && contentElement.getAsJsonPrimitive().isString()) {
            ClaudeImageReferenceRewrite rewrite = rewriteClaudeImageReferenceText(contentElement.getAsString());
            if (!rewrite.changed) {
                return originalMessage;
            }

            JsonObject normalizedMessage = originalMessage.deepCopy();
            normalizedMessage.getAsJsonObject("message").add("content", rewrite.contentBlocks);
            return normalizedMessage;
        }

        if (!contentElement.isJsonArray()) {
            return originalMessage;
        }

        JsonArray originalBlocks = contentElement.getAsJsonArray();
        JsonArray rebuiltBlocks = new JsonArray();
        boolean changed = false;

        for (JsonElement blockElement : originalBlocks) {
            if (!blockElement.isJsonObject()) {
                rebuiltBlocks.add(blockElement.deepCopy());
                continue;
            }

            JsonObject block = blockElement.getAsJsonObject();
            if (!isTextBlock(block)) {
                rebuiltBlocks.add(block.deepCopy());
                continue;
            }

            ClaudeImageReferenceRewrite rewrite = rewriteClaudeImageReferenceText(block.get("text").getAsString());
            if (!rewrite.changed) {
                rebuiltBlocks.add(block.deepCopy());
                continue;
            }

            changed = true;
            for (JsonElement normalizedBlock : rewrite.contentBlocks) {
                rebuiltBlocks.add(normalizedBlock);
            }
        }

        if (!changed) {
            return originalMessage;
        }

        JsonObject normalizedMessage = originalMessage.deepCopy();
        normalizedMessage.getAsJsonObject("message").add("content", rebuiltBlocks);
        return normalizedMessage;
    }

    private static boolean isTextBlock(JsonObject block) {
        return block.has("type")
                && "text".equals(block.get("type").getAsString())
                && block.has("text")
                && !block.get("text").isJsonNull();
    }

    private static ClaudeImageReferenceRewrite rewriteClaudeImageReferenceText(String text) {
        if (text == null) {
            return ClaudeImageReferenceRewrite.unchanged(null);
        }

        Matcher matcher = IMAGE_REFERENCE_PATTERN.matcher(text);
        StringBuilder remainingText = new StringBuilder();
        JsonArray contentBlocks = new JsonArray();
        int lastEnd = 0;
        boolean sawReference = false;
        boolean restoredImage = false;

        while (matcher.find()) {
            remainingText.append(text, lastEnd, matcher.start());
            lastEnd = matcher.end();
            sawReference = true;

            String imagePath = matcher.group(1) != null ? matcher.group(1).trim() : "";
            JsonObject imageBlock = createLocalImageBlock(imagePath);
            if (imageBlock != null) {
                contentBlocks.add(imageBlock);
                restoredImage = true;
            } else {
                remainingText.append(matcher.group());
            }
        }

        if (!sawReference || !restoredImage) {
            String sanitized = normalizeRemainingText(text);
            if (sanitized.equals(text)) {
                return ClaudeImageReferenceRewrite.unchanged(text);
            }
            appendTextBlock(contentBlocks, sanitized);
            return new ClaudeImageReferenceRewrite(true, contentBlocks);
        }

        remainingText.append(text.substring(lastEnd));
        String cleanedText = normalizeRemainingText(remainingText.toString());
        appendTextBlock(contentBlocks, cleanedText);
        return new ClaudeImageReferenceRewrite(true, contentBlocks);
    }

    private static String normalizeRemainingText(String text) {
        if (text == null) {
            return "";
        }
        String normalized = text.replace("\r\n", "\n");
        normalized = normalized.replace("\r", "\n");
        normalized = normalized.replace(IMAGE_ATTACHMENT_HINT, "");
        normalized = UserMessageSanitizer.sanitizeUserFacingText(normalized);
        normalized = normalized.replaceAll("(?m)^[ \\t]+$", "");
        normalized = normalized.replaceAll("\n{3,}", "\n\n");
        normalized = normalized.replaceAll("^(?:\\s*\\n)+", "");
        normalized = normalized.replaceAll("(?:\\n\\s*)+$", "");
        return normalized.trim();
    }

    private static void appendTextBlock(JsonArray contentBlocks, String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        contentBlocks.add(textBlock);
    }

    private static JsonObject createLocalImageBlock(String imagePath) {
        if (imagePath == null || imagePath.isBlank()) {
            return null;
        }

        try {
            Path path = Path.of(imagePath);
            if (!Files.isRegularFile(path)) {
                return null;
            }

            String mediaType = Files.probeContentType(path);
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = guessImageMediaType(path);
            }
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = "image/png";
            }

            String base64Data = Base64.getEncoder().encodeToString(Files.readAllBytes(path));
            JsonObject imageBlock = new JsonObject();
            imageBlock.addProperty("type", "image");
            imageBlock.addProperty("src", "data:" + mediaType + ";base64," + base64Data);
            imageBlock.addProperty("mediaType", mediaType);
            imageBlock.addProperty("alt", path.getFileName() != null ? path.getFileName().toString() : "image");
            return imageBlock;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String guessImageMediaType(Path path) {
        String fileName = path.getFileName() != null ? path.getFileName().toString().toLowerCase() : "";
        if (fileName.endsWith(".png")) {
            return "image/png";
        }
        if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (fileName.endsWith(".gif")) {
            return "image/gif";
        }
        if (fileName.endsWith(".webp")) {
            return "image/webp";
        }
        if (fileName.endsWith(".bmp")) {
            return "image/bmp";
        }
        if (fileName.endsWith(".svg")) {
            return "image/svg+xml";
        }
        return null;
    }

    private static final class ClaudeImageReferenceRewrite {
        private final boolean changed;
        private final JsonArray contentBlocks;

        private ClaudeImageReferenceRewrite(boolean changed, JsonArray contentBlocks) {
            this.changed = changed;
            this.contentBlocks = contentBlocks;
        }

        private static ClaudeImageReferenceRewrite unchanged(String originalText) {
            JsonArray contentBlocks = new JsonArray();
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", originalText != null ? originalText : "");
            contentBlocks.add(textBlock);
            return new ClaudeImageReferenceRewrite(false, contentBlocks);
        }
    }
}
