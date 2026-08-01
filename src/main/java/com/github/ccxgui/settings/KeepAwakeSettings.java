package com.github.ccxgui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;

/**
 * Persistence for the "keep the computer awake while an agent is working"
 * toggle.
 *
 * <p>One account-global value, {@code keepAwakeWhileAgentWorksEnabled}, default
 * off: suppressing sleep is a system-level side effect with a real battery cost,
 * so it stays an explicit opt-in. With the toggle off the plugin never touches
 * the platform's power state at all.
 */
public final class KeepAwakeSettings {

    private static final Logger LOG = Logger.getInstance(KeepAwakeSettings.class);

    static final String ENABLED_KEY = "keepAwakeWhileAgentWorksEnabled";

    /** Opt-in feature: stays off until the user turns it on. */
    public static final boolean DEFAULT_KEEP_AWAKE_ENABLED = false;

    private KeepAwakeSettings() {
    }

    public static boolean getKeepAwakeEnabled(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();
        if (!config.has(ENABLED_KEY)) {
            return DEFAULT_KEEP_AWAKE_ENABLED;
        }
        try {
            return config.get(ENABLED_KEY).getAsBoolean();
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid " + ENABLED_KEY + " value, rewriting default to disk; errorClass="
                    + e.getClass().getSimpleName());
            selfHealBoolean(service, config);
            return DEFAULT_KEEP_AWAKE_ENABLED;
        }
    }

    public static void setKeepAwakeEnabled(CodemossSettingsService service, boolean enabled) throws IOException {
        JsonObject config = service.readConfig();
        config.addProperty(ENABLED_KEY, enabled);
        service.writeConfig(config);
    }

    private static void selfHealBoolean(CodemossSettingsService service, JsonObject config) {
        try {
            config.addProperty(ENABLED_KEY, DEFAULT_KEEP_AWAKE_ENABLED);
            service.writeConfig(config);
        } catch (IOException rewriteError) {
            LOG.warn("[CodemossSettings] Failed to self-heal " + ENABLED_KEY + "; errorClass="
                    + rewriteError.getClass().getSimpleName());
        }
    }
}
