package com.github.ccxgui.provider.claude;

import com.github.ccxgui.provider.claude.ClaudeUsageLimitClassifier.Assessment;
import org.junit.Test;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for the pure usage-limit classifier: exhaustion detection with a
 * tolerant threshold, latest-reset attribution, {@code resets_at} parsing, and
 * the stricter verify-before-send clearance check with its hysteresis gap.
 */
public class ClaudeUsageLimitClassifierTest {

    private static final String RESET_EARLY_ISO = "2026-07-18T10:00:00Z";
    private static final String RESET_LATE_ISO = "2026-07-18T18:00:00Z";

    private static String window(double utilization, String resetsAtIso) {
        return "{\"utilization\":" + utilization + ",\"resets_at\":\"" + resetsAtIso + "\"}";
    }

    private static String windowNumeric(double utilization, long resetsAtNumber) {
        return "{\"utilization\":" + utilization + ",\"resets_at\":" + resetsAtNumber + "}";
    }

    private static String available(String usageBody) {
        return "{\"available\":true,\"usage\":{" + usageBody + "}}";
    }

    // ===== assess: non-limit / unparseable inputs =====

    @Test
    public void assessReturnsNoLimitForNullOrBlank() {
        assertFalse(ClaudeUsageLimitClassifier.assess(null).isLimitHit());
        assertFalse(ClaudeUsageLimitClassifier.assess("").isLimitHit());
        assertFalse(ClaudeUsageLimitClassifier.assess("   ").isLimitHit());
        assertFalse(ClaudeUsageLimitClassifier.assess("not json").isLimitHit());
    }

    @Test
    public void assessReturnsNoLimitWhenUnavailable() {
        Assessment a = ClaudeUsageLimitClassifier.assess("{\"available\":false,\"reason\":\"no_oauth\"}");
        assertFalse(a.isLimitHit());
        assertTrue(a.getExhaustedWindows().isEmpty());
        assertEquals(0L, a.getWakeAtMs());
    }

    @Test
    public void assessReturnsNoLimitWhenAllWindowsBelowThreshold() {
        String json = available(
                "\"five_hour\":" + window(80.0, RESET_EARLY_ISO)
                        + ",\"seven_day\":" + window(94.9, RESET_LATE_ISO));
        Assessment a = ClaudeUsageLimitClassifier.assess(json);
        assertFalse(a.isLimitHit());
        assertEquals(0L, a.getWakeAtMs());
    }

    // ===== assess: exhaustion detection =====

    @Test
    public void assessDetectsWindowAtToleranceThreshold() {
        // 95.0 is exactly EXHAUSTED_UTILIZATION — endpoint lag tolerance.
        String json = available("\"five_hour\":" + window(95.0, RESET_EARLY_ISO));
        Assessment a = ClaudeUsageLimitClassifier.assess(json);
        assertTrue(a.isLimitHit());
        assertTrue(a.getExhaustedWindows().contains("five_hour"));
        assertEquals(Instant.parse(RESET_EARLY_ISO).toEpochMilli(), a.getWakeAtMs());
    }

    @Test
    public void assessAttributesWakeToLatestResettingExhaustedWindow() {
        String json = available(
                "\"five_hour\":" + window(99.0, RESET_EARLY_ISO)
                        + ",\"seven_day\":" + window(100.0, RESET_LATE_ISO));
        Assessment a = ClaudeUsageLimitClassifier.assess(json);
        assertTrue(a.isLimitHit());
        assertEquals(2, a.getExhaustedWindows().size());
        // max(resets_at) so we never wake while the longer window is still blocking.
        assertEquals(Instant.parse(RESET_LATE_ISO).toEpochMilli(), a.getWakeAtMs());
    }

    @Test
    public void assessIgnoresExtraUsagePool() {
        // extra_usage is a monthly credit pool, not a turn-gating window.
        String json = available(
                "\"extra_usage\":" + window(100.0, RESET_LATE_ISO)
                        + ",\"five_hour\":" + window(10.0, RESET_EARLY_ISO));
        assertFalse(ClaudeUsageLimitClassifier.assess(json).isLimitHit());
    }

    @Test
    public void assessParsesNumericEpochSecondsAndMillis() {
        long epochSeconds = 1_800_000_000L; // 10 digits → seconds
        String secondsJson = available("\"five_hour\":" + windowNumeric(100.0, epochSeconds));
        assertEquals(epochSeconds * 1000L, ClaudeUsageLimitClassifier.assess(secondsJson).getWakeAtMs());

        long epochMillis = 1_800_000_000_000L; // 13 digits → millis
        String millisJson = available("\"seven_day\":" + windowNumeric(100.0, epochMillis));
        assertEquals(epochMillis, ClaudeUsageLimitClassifier.assess(millisJson).getWakeAtMs());
    }

    @Test
    public void assessTreatsExhaustedWindowWithoutResetAsZeroWake() {
        String json = available("\"five_hour\":{\"utilization\":100.0}");
        Assessment a = ClaudeUsageLimitClassifier.assess(json);
        assertTrue(a.isLimitHit());
        assertEquals(0L, a.getWakeAtMs());
    }

    // ===== allWindowsCleared: verify-before-send =====

    @Test
    public void allWindowsClearedTrueForEmptyPreviouslyExhausted() {
        assertTrue(ClaudeUsageLimitClassifier.allWindowsCleared(null, Collections.emptySet()));
        assertTrue(ClaudeUsageLimitClassifier.allWindowsCleared("garbage", null));
    }

    @Test
    public void allWindowsClearedFalseWhenPayloadUnreadable() {
        assertFalse(ClaudeUsageLimitClassifier.allWindowsCleared("not json", setOf("five_hour")));
        assertFalse(ClaudeUsageLimitClassifier.allWindowsCleared(
                "{\"available\":false}", setOf("five_hour")));
    }

    @Test
    public void allWindowsClearedTrueOnlyAfterDropBelowClearedThreshold() {
        String cleared = available("\"five_hour\":" + window(12.0, RESET_EARLY_ISO));
        assertTrue(ClaudeUsageLimitClassifier.allWindowsCleared(cleared, setOf("five_hour")));
    }

    @Test
    public void allWindowsClearedFalseWithinHysteresisGap() {
        // 92 is below EXHAUSTED (95) but at/above CLEARED (90): still blocking,
        // must not send until it drops under 90.
        String ambiguous = available("\"five_hour\":" + window(92.0, RESET_EARLY_ISO));
        assertFalse(ClaudeUsageLimitClassifier.allWindowsCleared(ambiguous, setOf("five_hour")));
    }

    @Test
    public void allWindowsClearedTreatsAbsentWindowAsCleared() {
        String json = available("\"seven_day\":" + window(50.0, RESET_LATE_ISO));
        assertTrue(ClaudeUsageLimitClassifier.allWindowsCleared(json, setOf("five_hour")));
    }

    @Test
    public void allWindowsClearedRequiresEveryPreviouslyExhaustedWindow() {
        String json = available(
                "\"five_hour\":" + window(5.0, RESET_EARLY_ISO)
                        + ",\"seven_day\":" + window(97.0, RESET_LATE_ISO));
        assertFalse(ClaudeUsageLimitClassifier.allWindowsCleared(json, setOf("five_hour", "seven_day")));
    }

    private static Set<String> setOf(String... keys) {
        return new LinkedHashSet<>(java.util.Arrays.asList(keys));
    }
}
