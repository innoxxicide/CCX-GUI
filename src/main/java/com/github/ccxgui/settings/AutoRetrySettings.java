package com.github.ccxgui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;

/**
 * Persistence for the "retry automatically after an error" feature.
 *
 * <p>When enabled, a turn that dies on an error — an API failure, a dropped
 * connection, an SDK crash — is nudged back to life by sending the agent a short
 * message, first three times a minute apart and then every five minutes, until it
 * answers or the user stops it.
 *
 * <p>Usage-limit stops are deliberately excluded: those are not transient, and
 * they already have a purpose-built path that waits for the reset time rather
 * than hammering a blocked account. See {@link ClaudeAutoResumeSettings}.
 *
 * <p>Unlike auto-resume this is not Claude-specific — any provider's turn can
 * fail this way — which is why the keys are unprefixed and the setting lives on
 * the provider-neutral Behaviour tab. Two account-global values:
 * <ul>
 *   <li>{@code autoRetryOnErrorEnabled} — the master toggle, default off.</li>
 *   <li>{@code autoRetryPrompt} — the nudge text sent to the agent, default
 *       {@link #DEFAULT_AUTO_RETRY_PROMPT}.</li>
 * </ul>
 */
public final class AutoRetrySettings {

    private static final Logger LOG = Logger.getInstance(AutoRetrySettings.class);

    static final String ENABLED_KEY = "autoRetryOnErrorEnabled";
    static final String PROMPT_KEY = "autoRetryPrompt";

    /** Opt-in feature: stays off until the user turns it on. */
    public static final boolean DEFAULT_AUTO_RETRY_ENABLED = false;
    public static final String DEFAULT_AUTO_RETRY_PROMPT = "Continue working on the task.";
    public static final int MAX_AUTO_RETRY_PROMPT_LENGTH = 10000;

    private AutoRetrySettings() {
    }

    public static boolean getAutoRetryEnabled(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();
        if (!config.has(ENABLED_KEY)) {
            return DEFAULT_AUTO_RETRY_ENABLED;
        }
        try {
            return config.get(ENABLED_KEY).getAsBoolean();
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid " + ENABLED_KEY + " value, rewriting default to disk; errorClass="
                    + e.getClass().getSimpleName());
            selfHealBoolean(service, config);
            return DEFAULT_AUTO_RETRY_ENABLED;
        }
    }

    public static void setAutoRetryEnabled(CodemossSettingsService service, boolean enabled) throws IOException {
        JsonObject config = service.readConfig();
        config.addProperty(ENABLED_KEY, enabled);
        service.writeConfig(config);
    }

    public static String getAutoRetryPrompt(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();
        if (!config.has(PROMPT_KEY) || config.get(PROMPT_KEY).isJsonNull()) {
            return DEFAULT_AUTO_RETRY_PROMPT;
        }
        try {
            String normalized = normalizePrompt(config.get(PROMPT_KEY).getAsString());
            return normalized.isEmpty() ? DEFAULT_AUTO_RETRY_PROMPT : normalized;
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid " + PROMPT_KEY + " value, ignoring; errorClass="
                    + e.getClass().getSimpleName());
            return DEFAULT_AUTO_RETRY_PROMPT;
        }
    }

    public static void setAutoRetryPrompt(CodemossSettingsService service, String prompt) throws IOException {
        String normalized = normalizePrompt(prompt);
        if (normalized.isEmpty()) {
            normalized = DEFAULT_AUTO_RETRY_PROMPT;
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
        if (trimmed.length() > MAX_AUTO_RETRY_PROMPT_LENGTH) {
            trimmed = trimmed.substring(0, MAX_AUTO_RETRY_PROMPT_LENGTH);
        }
        return trimmed;
    }

    private static void selfHealBoolean(CodemossSettingsService service, JsonObject config) {
        try {
            config.addProperty(ENABLED_KEY, DEFAULT_AUTO_RETRY_ENABLED);
            service.writeConfig(config);
        } catch (IOException rewriteError) {
            LOG.warn("[CodemossSettings] Failed to self-heal " + ENABLED_KEY + "; errorClass="
                    + rewriteError.getClass().getSimpleName());
        }
    }
}
