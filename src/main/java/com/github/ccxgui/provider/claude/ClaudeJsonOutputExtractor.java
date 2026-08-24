package com.github.ccxgui.provider.claude;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import java.io.StringReader;

/**
 * Shared helpers for parsing mixed stdout output from Node.js bridge commands.
 */
class ClaudeJsonOutputExtractor {

    String extractBetween(String text, String start, String end) {
        int startIdx = text.indexOf(start);
        if (startIdx == -1) {
            return null;
        }
        startIdx += start.length();

        int endIdx = text.indexOf(end, startIdx);
        if (endIdx == -1) {
            return null;
        }

        return text.substring(startIdx, endIdx);
    }

    /**
     * Pick the bridge's JSON result out of a stdout stream that also carries plain
     * diagnostic lines.
     *
     * <p>Every returned candidate is validated as a complete JSON document, so a
     * caller never has to defend against a half-payload. That matters because the
     * bridge's diagnostics print raw Windows paths ({@code C:\Users\...}): if such a
     * line ever lands inside the payload line, the {@code \U} reads as an invalid
     * JSON escape and Gson fails deep inside the document with a message that looks
     * like a data bug rather than a stream bug. Refusing the candidate here lets the
     * caller retry instead of surfacing that.</p>
     *
     * @param outputStr full stdout captured from the bridge process.
     * @return a complete JSON object document, or null if the output holds none.
     */
    String extractLastJsonLine(String outputStr) {
        if (outputStr == null || outputStr.isEmpty()) {
            return null;
        }

        String[] lines = outputStr.split("\\r?\\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}") && isCompleteJsonDocument(line)) {
                return line;
            }
        }

        // Pretty-printed payloads span several lines; accept the whole stream only
        // when it is itself one complete document. Deliberately no "substring from
        // the first brace" fallback: that cannot do anything but splice trailing
        // diagnostic lines into the payload.
        String trimmed = outputStr.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}") && isCompleteJsonDocument(trimmed)) {
            return trimmed;
        }

        return null;
    }

    /**
     * Check that the text parses as exactly one JSON value with nothing trailing.
     * Uses the same leniency {@code Gson#fromJson} applies, so a document accepted
     * here cannot be rejected by the caller's parse.
     *
     * @param text candidate JSON document.
     * @return true if the text is a single complete JSON value.
     */
    private static boolean isCompleteJsonDocument(String text) {
        JsonReader reader = new JsonReader(new StringReader(text));
        reader.setLenient(true);
        try {
            reader.skipValue();
            return reader.peek() == JsonToken.END_DOCUMENT;
        } catch (Exception e) {
            return false;
        }
    }

    String extractErrorMessage(Throwable throwable) {
        if (throwable == null) {
            return "Unknown error";
        }

        Throwable current = throwable;
        while (current != null) {
            String msg = current.getMessage();
            if (msg != null && !msg.trim().isEmpty()) {
                return msg;
            }
            current = current.getCause();
        }
        return throwable.getClass().getSimpleName();
    }
}
