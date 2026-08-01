package com.github.ccxgui.settings;

import com.github.ccxgui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodemossSettingsServiceKeepAwakeTest {

    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void defaultsToOffWhenTheKeyIsMissing() throws Exception {
        Path tempHome = Files.createTempDirectory("keep-awake-default-home");
        useTemporaryHomeDirectory(tempHome);

        // Suppressing sleep is a system-level side effect, so it must never be on
        // for a user who has not asked for it.
        assertFalse(new CodemossSettingsService().getKeepAwakeEnabled());
    }

    @Test
    public void persistsTheToggle() throws Exception {
        Path tempHome = Files.createTempDirectory("keep-awake-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setKeepAwakeEnabled(true);
        assertTrue(service.getKeepAwakeEnabled());

        JsonObject config = service.readConfig();
        assertTrue(config.get("keepAwakeWhileAgentWorksEnabled").getAsBoolean());
    }

    @Test
    public void fallsBackToOffOnAMalformedValue() throws Exception {
        Path tempHome = Files.createTempDirectory("keep-awake-malformed-home");
        useTemporaryHomeDirectory(tempHome);

        Path configPath = tempHome.resolve(".codemoss").resolve("config.json");
        Files.writeString(configPath, "{\"keepAwakeWhileAgentWorksEnabled\":\"yes please\"}", StandardCharsets.UTF_8);

        CodemossSettingsService service = new CodemossSettingsService();
        assertFalse(service.getKeepAwakeEnabled());
        // The bad value is rewritten so the next read does not re-parse it.
        assertFalse(service.readConfig().get("keepAwakeWhileAgentWorksEnabled").getAsBoolean());
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
