package com.github.ccxgui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;

/**
 * Persistence for the Claude "auto-resume after usage-limit reset" feature.
 *
 * <p>When enabled, a Claude session that stops because it hit the account's
 * 5-hour or weekly usage limit schedules a wake-up message for the moment the
 * limit resets, so long-running work continues without manual nudging. The
 * feature is Claude-only and meaningful only for OAuth (Pro/Max) logins.
 *
 * <p>Two values are stored, both account-global (not project scoped):
 * <ul>
 *   <li>{@code claudeAutoResumeOnLimitEnabled} — the master toggle, default off.</li>
 *   <li>{@code claudeAutoResumePrompt} — the wake-up prompt text sent to the
 *       agent, default {@link #DEFAULT_CLAUDE_AUTO_RESUME_PROMPT}.</li>
 * </ul>
 */
public final class ClaudeAutoResumeSettings {

    private static final Logger LOG = Logger.getInstance(ClaudeAutoResumeSettings.class);

    static final String ENABLED_KEY = "claudeAutoResumeOnLimitEnabled";
    static final String PROMPT_KEY = "claudeAutoResumePrompt";

    /** Opt-in feature: stays off until the user turns it on. */
    public static final boolean DEFAULT_CLAUDE_AUTO_RESUME_ENABLED = false;
    public static final String DEFAULT_CLAUDE_AUTO_RESUME_PROMPT = "Please continue where you left off.";
    public static final int MAX_CLAUDE_AUTO_RESUME_PROMPT_LENGTH = 10000;

    private ClaudeAutoResumeSettings() {
    }

    public static boolean getClaudeAutoResumeEnabled(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();
        if (!config.has(ENABLED_KEY)) {
            return DEFAULT_CLAUDE_AUTO_RESUME_ENABLED;
        }
        try {
            return config.get(ENABLED_KEY).getAsBoolean();
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid " + ENABLED_KEY + " value, rewriting default to disk; errorClass="
                    + e.getClass().getSimpleName());
            selfHealBoolean(service, config);
            return DEFAULT_CLAUDE_AUTO_RESUME_ENABLED;
        }
    }

    public static void setClaudeAutoResumeEnabled(CodemossSettingsService service, boolean enabled) throws IOException {
        JsonObject config = service.readConfig();
        config.addProperty(ENABLED_KEY, enabled);
        service.writeConfig(config);
    }

    public static String getClaudeAutoResumePrompt(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();
        if (!config.has(PROMPT_KEY) || config.get(PROMPT_KEY).isJsonNull()) {
            return DEFAULT_CLAUDE_AUTO_RESUME_PROMPT;
        }
        try {
            String value = config.get(PROMPT_KEY).getAsString();
            String normalized = normalizePrompt(value);
            return normalized.isEmpty() ? DEFAULT_CLAUDE_AUTO_RESUME_PROMPT : normalized;
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid " + PROMPT_KEY + " value, ignoring; errorClass="
                    + e.getClass().getSimpleName());
            return DEFAULT_CLAUDE_AUTO_RESUME_PROMPT;
        }
    }

    public static void setClaudeAutoResumePrompt(CodemossSettingsService service, String prompt) throws IOException {
        String normalized = normalizePrompt(prompt);
        if (normalized.isEmpty()) {
            normalized = DEFAULT_CLAUDE_AUTO_RESUME_PROMPT;
        }
        JsonObject config = service.readConfig();
        config.addProperty(PROMPT_KEY, normalized);
        service.writeConfig(config);
    }

    private static String normalizePrompt(String prompt) {
        if (prompt == null) {
            return "";
        }
        String trimmed = prompt.trim();
        if (trimmed.length() > MAX_CLAUDE_AUTO_RESUME_PROMPT_LENGTH) {
            trimmed = trimmed.substring(0, MAX_CLAUDE_AUTO_RESUME_PROMPT_LENGTH);
        }
        return trimmed;
    }

    private static void selfHealBoolean(CodemossSettingsService service, JsonObject config) {
        try {
            config.addProperty(ENABLED_KEY, DEFAULT_CLAUDE_AUTO_RESUME_ENABLED);
            service.writeConfig(config);
        } catch (IOException rewriteError) {
            LOG.warn("[CodemossSettings] Failed to self-heal " + ENABLED_KEY + "; errorClass="
                    + rewriteError.getClass().getSimpleName());
        }
    }
}
