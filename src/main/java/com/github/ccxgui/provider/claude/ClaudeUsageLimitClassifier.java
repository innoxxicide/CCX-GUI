package com.github.ccxgui.provider.claude;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Pure, side-effect-free classifier that decides whether a Claude turn stopped
 * because the signed-in account hit a usage-limit window, using the normalized
 * usage payload produced by {@link ClaudeUsageLimitsService}.
 *
 * <p>The auto-resume feature triggers a fresh usage fetch whenever a turn ends
 * with an error and then asks this classifier: is any rate-limit window
 * exhausted, and if so, when does the latest of them reset? The reset time
 * drives the scheduled wake-up.
 *
 * <p>Detection is deliberately tolerant. The OAuth usage endpoint can lag
 * enforcement, so a window that is actually blocking may read a few points
 * under 100%. We therefore treat any window at or above
 * {@link #EXHAUSTED_UTILIZATION} as exhausted rather than demanding an exact
 * 100%, and we attribute the wake to the <em>latest-resetting</em> exhausted
 * window ({@code max(resets_at)}) so the agent is never woken while a second,
 * longer window is still blocking.
 */
public final class ClaudeUsageLimitClassifier {

    /**
     * A window at or above this utilization is treated as exhausted at detection
     * time. Below 100% on purpose: the usage endpoint can report slightly under
     * 100% at the instant the limit begins blocking.
     */
    public static final double EXHAUSTED_UTILIZATION = 95.0;

    /**
     * At verify-before-send time a previously-exhausted window is considered
     * cleared once its utilization drops below this value. After a reset the
     * window falls to near zero, so any reading well under the exhausted
     * threshold is an unambiguous "reset happened".
     */
    public static final double CLEARED_UTILIZATION = 90.0;

    /**
     * The rate-limit windows that can block a turn, in the order we report them.
     * {@code extra_usage} is intentionally excluded: it is a monthly credit pool
     * with a different shape and does not gate the 5-hour/weekly turn budget.
     */
    private static final String[] WINDOW_KEYS = {
            "five_hour",
            "seven_day",
            "seven_day_opus",
            "seven_day_sonnet",
            "seven_day_oauth_apps",
            "seven_day_cowork"
    };

    private ClaudeUsageLimitClassifier() {
    }

    /**
     * Result of assessing a usage payload for exhausted windows.
     */
    public static final class Assessment {
        private final boolean limitHit;
        private final long wakeAtMs;
        private final Set<String> exhaustedWindows;

        private Assessment(boolean limitHit, long wakeAtMs, Set<String> exhaustedWindows) {
            this.limitHit = limitHit;
            this.wakeAtMs = wakeAtMs;
            this.exhaustedWindows = Collections.unmodifiableSet(exhaustedWindows);
        }

        /** Whether at least one rate-limit window is exhausted. */
        public boolean isLimitHit() {
            return limitHit;
        }

        /**
         * Epoch millis of the latest reset among exhausted windows, or {@code 0}
         * when {@link #isLimitHit()} is false or no exhausted window carried a
         * parseable {@code resets_at}. The scheduler adds its own buffer.
         */
        public long getWakeAtMs() {
            return wakeAtMs;
        }

        /** The window keys (e.g. {@code five_hour}) that were exhausted. */
        public Set<String> getExhaustedWindows() {
            return exhaustedWindows;
        }
    }

    /**
     * Assess a usage payload (the JSON string produced by
     * {@link ClaudeUsageLimitsService}) for exhausted windows.
     *
     * @param usagePayloadJson normalized payload; {@code {available, usage:{...}}}
     * @return a never-null assessment; {@code limitHit=false} for unavailable or
     *         unparseable payloads
     */
    public static Assessment assess(String usagePayloadJson) {
        Set<String> exhausted = new LinkedHashSet<>();
        long maxResetMs = 0L;

        JsonObject usage = extractUsageObject(usagePayloadJson);
        if (usage == null) {
            return new Assessment(false, 0L, exhausted);
        }

        for (String key : WINDOW_KEYS) {
            JsonObject window = asObject(usage.get(key));
            if (window == null) {
                continue;
            }
            double utilization = readUtilization(window);
            if (utilization >= EXHAUSTED_UTILIZATION) {
                exhausted.add(key);
                long resetMs = readResetsAtMillis(window);
                if (resetMs > maxResetMs) {
                    maxResetMs = resetMs;
                }
            }
        }

        return new Assessment(!exhausted.isEmpty(), maxResetMs, exhausted);
    }

    /**
     * Verify — at wake time, using a freshly fetched payload — whether every
     * window that had been exhausted has now reset. Used as the safety net so
     * the agent is only resumed once the block has actually lifted.
     *
     * @param usagePayloadJson freshly fetched payload
     * @param previouslyExhausted the window keys that armed the wake
     * @return {@code true} when all previously-exhausted windows read below
     *         {@link #CLEARED_UTILIZATION} (or are absent); {@code false} when any
     *         is still at/above it, meaning the caller should retry later
     */
    public static boolean allWindowsCleared(String usagePayloadJson, Set<String> previouslyExhausted) {
        if (previouslyExhausted == null || previouslyExhausted.isEmpty()) {
            return true;
        }
        JsonObject usage = extractUsageObject(usagePayloadJson);
        if (usage == null) {
            // No readable data: don't claim cleared, let the caller retry.
            return false;
        }
        for (String key : previouslyExhausted) {
            JsonObject window = asObject(usage.get(key));
            if (window == null) {
                continue;
            }
            if (readUtilization(window) >= CLEARED_UTILIZATION) {
                return false;
            }
        }
        return true;
    }

    private static JsonObject extractUsageObject(String usagePayloadJson) {
        if (usagePayloadJson == null || usagePayloadJson.isBlank()) {
            return null;
        }
        try {
            JsonObject root = JsonParser.parseString(usagePayloadJson).getAsJsonObject();
            if (root.has("available") && !root.get("available").getAsBoolean()) {
                return null;
            }
            return asObject(root.get("usage"));
        } catch (Exception e) {
            return null;
        }
    }

    private static double readUtilization(JsonObject window) {
        JsonElement util = window.get("utilization");
        if (util == null || util.isJsonNull()) {
            return 0.0;
        }
        try {
            return util.getAsDouble();
        } catch (Exception e) {
            return 0.0;
        }
    }

    /**
     * Parse a window's {@code resets_at} into epoch millis. Accepts an ISO-8601
     * instant/offset string (the endpoint's native format) and, defensively, a
     * numeric epoch in seconds or millis. Returns {@code 0} when absent/unparseable.
     */
    private static long readResetsAtMillis(JsonObject window) {
        JsonElement el = window.get("resets_at");
        if (el == null || el.isJsonNull()) {
            return 0L;
        }
        if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
            long raw = el.getAsLong();
            // Heuristic: 10-digit values are epoch seconds, 13-digit are millis.
            return raw < 100_000_000_000L ? raw * 1000L : raw;
        }
        String text = el.getAsString();
        if (text == null || text.isBlank()) {
            return 0L;
        }
        try {
            return Instant.parse(text).toEpochMilli();
        } catch (Exception ignored) {
            // fall through
        }
        try {
            return OffsetDateTime.parse(text).toInstant().toEpochMilli();
        } catch (Exception ignored) {
            // fall through
        }
        try {
            long raw = Long.parseLong(text.trim());
            return raw < 100_000_000_000L ? raw * 1000L : raw;
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static JsonObject asObject(JsonElement element) {
        return (element != null && element.isJsonObject()) ? element.getAsJsonObject() : null;
    }
}
