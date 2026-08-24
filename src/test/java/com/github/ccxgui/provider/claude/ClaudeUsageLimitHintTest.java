package com.github.ccxgui.provider.claude;

import org.junit.Test;

import java.time.ZoneId;
import java.time.ZonedDateTime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the bridge's usage-limit verdict: payload parsing, and recovering a
 * reset time from the notice text, which is the only reset information available
 * when the stop was observed as text (a subagent's tool_result, a background
 * agent's task_notification, or the CLI's synthetic assistant message).
 */
public class ClaudeUsageLimitHintTest {

    @Test
    public void parsesFullPayload() {
        ClaudeUsageLimitHint hint = ClaudeUsageLimitHint.parse(
                "{\"limitHit\":true,\"message\":\"You've hit your session limit\","
                        + "\"resetsAt\":1764512400,\"source\":\"task_notification\","
                        + "\"sidechain\":true,\"raiseError\":true}");

        assertNotNull(hint);
        assertTrue(hint.isLimitHit());
        assertEquals("You've hit your session limit", hint.getMessage());
        assertEquals(1764512400000L, hint.getResetsAtMs());
        assertEquals("task_notification", hint.getSource());
        assertTrue(hint.isSidechain());
        assertTrue(hint.shouldRaiseError());
    }

    @Test
    public void acceptsMillisecondEpochUnchanged() {
        ClaudeUsageLimitHint hint = ClaudeUsageLimitHint.parse(
                "{\"limitHit\":true,\"message\":\"blocked\",\"resetsAt\":1764512400000}");

        assertNotNull(hint);
        assertEquals(1764512400000L, hint.getResetsAtMs());
    }

    @Test
    public void rejectsPayloadsThatClaimNoLimit() {
        assertNull(ClaudeUsageLimitHint.parse("{\"limitHit\":false,\"message\":\"nope\"}"));
        assertNull(ClaudeUsageLimitHint.parse("{}"));
    }

    @Test
    public void rejectsUnusablePayloads() {
        assertNull(ClaudeUsageLimitHint.parse(null));
        assertNull(ClaudeUsageLimitHint.parse(""));
        assertNull(ClaudeUsageLimitHint.parse("not json"));
        assertNull(ClaudeUsageLimitHint.parse("[1,2,3]"));
    }

    @Test
    public void defaultsRaiseErrorToFalse() {
        // Absent means "a [SEND_ERROR] is already in flight" — never invent an
        // extra error card for a failure that is about to be reported anyway.
        ClaudeUsageLimitHint hint = ClaudeUsageLimitHint.parse("{\"limitHit\":true,\"message\":\"blocked\"}");

        assertNotNull(hint);
        assertFalse(hint.shouldRaiseError());
    }

    // ===== reset time recovered from the notice text =====

    @Test
    public void derivesResetFromNoticeWhenNoEpochIsGiven() {
        long expected = nextOccurrence("Europe/Kiev", 15, 0);

        ClaudeUsageLimitHint hint = ClaudeUsageLimitHint.parse(
                "{\"limitHit\":true,\"message\":\"You've hit your session limit \\u00b7 resets 3pm (Europe/Kiev)\"}");

        assertNotNull(hint);
        assertEquals(expected, hint.getResetsAtMs());
    }

    @Test
    public void parsesHourAndMinuteInStatedZone() {
        assertEquals(nextOccurrence("Europe/Kiev", 11, 30),
                ClaudeUsageLimitHint.parseResetsAtFromText(
                        "You've hit your session limit · resets 11:30am (Europe/Kiev)"));
        assertEquals(nextOccurrence("America/New_York", 13, 10),
                ClaudeUsageLimitHint.parseResetsAtFromText(
                        "You've hit your session limit · resets 1:10pm (America/New_York)"));
    }

    @Test
    public void parsesMidnightAndNoonBoundaries() {
        assertEquals(nextOccurrence("Europe/Kiev", 0, 10),
                ClaudeUsageLimitHint.parseResetsAtFromText("resets 12:10am (Europe/Kiev)"));
        assertEquals(nextOccurrence("Europe/Kiev", 12, 10),
                ClaudeUsageLimitHint.parseResetsAtFromText("resets 12:10pm (Europe/Kiev)"));
    }

    @Test
    public void resolvesToTheNextOccurrenceOfTheStatedWeekday() {
        long resetAt = ClaudeUsageLimitHint.parseResetsAtFromText(
                "You've hit your weekly limit · resets Thu 9am (Europe/Kiev)");

        ZonedDateTime resolved = java.time.Instant.ofEpochMilli(resetAt).atZone(ZoneId.of("Europe/Kiev"));
        assertEquals(java.time.DayOfWeek.THURSDAY, resolved.getDayOfWeek());
        assertEquals(9, resolved.getHour());
        assertTrue(resetAt > System.currentTimeMillis());
    }

    @Test
    public void alwaysResolvesToTheFuture() {
        // The notice states a time but no date, so a time that already passed today
        // means tomorrow — never a wake that is already overdue.
        for (int hour = 1; hour <= 12; hour++) {
            long resetAt = ClaudeUsageLimitHint.parseResetsAtFromText("resets " + hour + "am (Europe/Kiev)");
            assertTrue("hour " + hour + "am resolved into the past", resetAt > System.currentTimeMillis());
        }
    }

    @Test
    public void fallsBackToTheSystemZoneWhenNoneIsStated() {
        assertEquals(nextOccurrence(ZoneId.systemDefault().getId(), 21, 0),
                ClaudeUsageLimitHint.parseResetsAtFromText("resets 9pm"));
    }

    @Test
    public void returnsZeroForTextWithoutAParseableResetTime() {
        assertEquals(0L, ClaudeUsageLimitHint.parseResetsAtFromText(null));
        assertEquals(0L, ClaudeUsageLimitHint.parseResetsAtFromText(""));
        assertEquals(0L, ClaudeUsageLimitHint.parseResetsAtFromText("Claude usage limit reached."));
        assertEquals(0L, ClaudeUsageLimitHint.parseResetsAtFromText("resets 25:99pm (Europe/Kiev)"));
    }

    @Test
    public void ignoresAnUnknownZoneRatherThanFailing() {
        assertEquals(nextOccurrence(ZoneId.systemDefault().getId(), 15, 0),
                ClaudeUsageLimitHint.parseResetsAtFromText("resets 3pm (Not/AZone)"));
    }

    /** The next time {@code hour24:minute} occurs in {@code zone}, in epoch millis. */
    private static long nextOccurrence(String zone, int hour24, int minute) {
        ZoneId zoneId = ZoneId.of(zone);
        ZonedDateTime now = ZonedDateTime.now(zoneId);
        ZonedDateTime candidate = now.with(java.time.LocalTime.of(hour24, minute));
        if (!candidate.isAfter(now)) {
            candidate = candidate.plusDays(1);
        }
        return candidate.toInstant().toEpochMilli();
    }
}
