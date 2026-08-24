package com.github.ccxgui.provider.claude;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.time.DayOfWeek;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.TextStyle;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A "this turn stopped on a usage limit" report from the ai-bridge, parsed.
 *
 * <p>The bridge detects the stop (see {@code ai-bridge/services/claude/usage-limit-detector.js})
 * and sends the notice text plus, when the SDK provided one, the reset epoch.
 * This class turns that payload into the two things the auto-resume controller
 * needs: <em>is this a limit stop at all</em>, and <em>when does it lift</em>.
 *
 * <p>Why it matters that this is authoritative: the controller's other source is
 * the account-usage endpoint, which lags enforcement and is simply unavailable
 * for API-key accounts. A hint says the limit was hit even when the endpoint
 * disagrees, which is what makes the wake fire in the cases this class exists for.
 */
public final class ClaudeUsageLimitHint {

    /**
     * Wall-clock reset time carried by the notice itself — the only reset
     * information available when the stop was observed as text (a subagent's
     * tool_result, a background agent's task_notification, a synthetic assistant
     * message). Shapes seen in the wild:
     * <pre>
     *   You've hit your session limit · resets 3pm (Europe/Kiev)
     *   You've hit your session limit · resets 11:30am (Europe/Kiev)
     *   You've hit your weekly limit · resets Thu 9am (America/New_York)
     * </pre>
     */
    private static final Pattern RESETS_AT = Pattern.compile(
            "resets\\s+(?:(?<weekday>[A-Za-z]{3,9})\\s+)?(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?\\s*(?<meridiem>[ap]m)"
                    + "(?:\\s*\\((?<zone>[A-Za-z]+(?:/[A-Za-z_+\\-0-9]+)+|UTC)\\))?",
            Pattern.CASE_INSENSITIVE);

    private final boolean limitHit;
    private final String message;
    private final long resetsAtMs;
    private final String source;
    private final boolean sidechain;
    private final boolean raiseError;

    private ClaudeUsageLimitHint(boolean limitHit, String message, long resetsAtMs,
                                 String source, boolean sidechain, boolean raiseError) {
        this.limitHit = limitHit;
        this.message = message;
        this.resetsAtMs = resetsAtMs;
        this.source = source;
        this.sidechain = sidechain;
        this.raiseError = raiseError;
    }

    /**
     * Parse a {@code [LIMIT_ERROR]} / {@code usage_limit} payload.
     *
     * @param json the payload emitted by the bridge; may be null or malformed
     * @return the parsed hint, or {@code null} when the payload is unusable or
     *         does not claim a limit was hit
     */
    public static ClaudeUsageLimitHint parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return from(JsonParser.parseString(json).getAsJsonObject());
        } catch (Exception e) {
            return null;
        }
    }

    /** Object form of {@link #parse(String)}, for the daemon-event path. */
    public static ClaudeUsageLimitHint from(JsonObject payload) {
        if (payload == null || !readBoolean(payload, "limitHit", false)) {
            return null;
        }
        String message = readString(payload, "message", "Claude usage limit reached.");
        long resetsAtMs = normalizeEpoch(readLong(payload, "resetsAt", 0L));
        if (resetsAtMs <= 0) {
            resetsAtMs = parseResetsAtFromText(message);
        }
        return new ClaudeUsageLimitHint(
                true,
                message,
                resetsAtMs,
                readString(payload, "source", "unknown"),
                readBoolean(payload, "sidechain", false),
                readBoolean(payload, "raiseError", false));
    }

    /** Always true for a non-null hint; kept explicit at call sites for readability. */
    public boolean isLimitHit() {
        return limitHit;
    }

    /** The limit notice, suitable for display as the turn's error. */
    public String getMessage() {
        return message;
    }

    /** Epoch millis when the limit lifts, or {@code 0} when it could not be determined. */
    public long getResetsAtMs() {
        return resetsAtMs;
    }

    /** Which signal detected the stop (assistant / tool_result / task_notification / …). */
    public String getSource() {
        return source;
    }

    /** Whether a subagent, rather than the main agent, was the one blocked. */
    public boolean isSidechain() {
        return sidechain;
    }

    /**
     * Whether the receiver must synthesize the turn error itself. False when a
     * {@code [SEND_ERROR]} for the same stop is already in flight, so the error
     * is not reported twice.
     */
    public boolean shouldRaiseError() {
        return raiseError;
    }

    /**
     * Resolve the wall-clock reset time in a notice to epoch millis.
     *
     * <p>The notice states a time but not a date, so the result is the next
     * occurrence of that time — in the stated zone when one is given, otherwise in
     * the system zone. A weekday, when present, selects the next matching day.
     * Being slightly wrong here is safe: the controller re-checks account usage at
     * the wake and reschedules if the block has not actually lifted.
     *
     * @return epoch millis, or {@code 0} when the text carries no parseable time
     */
    public static long parseResetsAtFromText(String text) {
        if (text == null || text.isBlank()) {
            return 0L;
        }
        Matcher matcher = RESETS_AT.matcher(text);
        if (!matcher.find()) {
            return 0L;
        }
        try {
            int hour = Integer.parseInt(matcher.group("hour"));
            if (hour < 1 || hour > 12) {
                return 0L;
            }
            String minuteGroup = matcher.group("minute");
            int minute = minuteGroup != null ? Integer.parseInt(minuteGroup) : 0;
            if (minute > 59) {
                return 0L;
            }
            boolean pm = matcher.group("meridiem").equalsIgnoreCase("pm");
            int hour24 = (hour % 12) + (pm ? 12 : 0);

            ZoneId zone = resolveZone(matcher.group("zone"));
            ZonedDateTime now = ZonedDateTime.now(zone);
            ZonedDateTime candidate = now.with(LocalTime.of(hour24, minute));

            DayOfWeek weekday = parseWeekday(matcher.group("weekday"));
            if (weekday != null) {
                while (candidate.getDayOfWeek() != weekday || !candidate.isAfter(now)) {
                    candidate = candidate.plusDays(1);
                }
            } else if (!candidate.isAfter(now)) {
                // The stated time already passed today, so it means tomorrow.
                candidate = candidate.plusDays(1);
            }
            return candidate.toInstant().toEpochMilli();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static ZoneId resolveZone(String zoneText) {
        if (zoneText == null || zoneText.isBlank()) {
            return ZoneId.systemDefault();
        }
        try {
            return ZoneId.of(zoneText.trim());
        } catch (Exception e) {
            return ZoneId.systemDefault();
        }
    }

    private static DayOfWeek parseWeekday(String weekdayText) {
        if (weekdayText == null || weekdayText.isBlank()) {
            return null;
        }
        String normalized = weekdayText.trim().toLowerCase(Locale.ROOT);
        for (DayOfWeek day : DayOfWeek.values()) {
            String full = day.getDisplayName(TextStyle.FULL, Locale.ENGLISH).toLowerCase(Locale.ROOT);
            String shortName = day.getDisplayName(TextStyle.SHORT, Locale.ENGLISH).toLowerCase(Locale.ROOT);
            if (full.equals(normalized) || shortName.equals(normalized)) {
                return day;
            }
        }
        return null;
    }

    /** 10-digit values are epoch seconds, 13-digit are millis. */
    private static long normalizeEpoch(long raw) {
        if (raw <= 0) {
            return 0L;
        }
        return raw < 100_000_000_000L ? raw * 1000L : raw;
    }

    private static String readString(JsonObject obj, String key, String fallback) {
        return obj.has(key) && obj.get(key).isJsonPrimitive() ? obj.get(key).getAsString() : fallback;
    }

    private static boolean readBoolean(JsonObject obj, String key, boolean fallback) {
        try {
            return obj.has(key) && obj.get(key).isJsonPrimitive() ? obj.get(key).getAsBoolean() : fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    private static long readLong(JsonObject obj, String key, long fallback) {
        try {
            return obj.has(key) && obj.get(key).isJsonPrimitive() ? obj.get(key).getAsLong() : fallback;
        } catch (Exception e) {
            return fallback;
        }
    }
}
