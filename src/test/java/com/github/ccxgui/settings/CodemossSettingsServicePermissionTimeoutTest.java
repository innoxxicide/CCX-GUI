package com.github.ccxgui.settings;

import com.github.ccxgui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodemossSettingsServicePermissionTimeoutTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void clampsPermissionDialogTimeoutToSupportedRange() {
        assertEquals(120, CodemossSettingsService.clampPermissionDialogTimeoutSeconds(120));
        assertEquals(30, CodemossSettingsService.clampPermissionDialogTimeoutSeconds(1));
        assertEquals(3600, CodemossSettingsService.clampPermissionDialogTimeoutSeconds(99999));
    }

    @Test
    public void defaultsMissingOrInvalidPermissionDialogTimeout() throws Exception {
        Path tempHome = Files.createTempDirectory("permission-timeout-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertEquals(300, service.getPermissionDialogTimeoutSeconds());

        Path configPath = tempHome.resolve(".codemoss").resolve("config.json");
        Files.writeString(configPath, "{\"permissionDialogTimeoutSeconds\":\"bad\"}", StandardCharsets.UTF_8);

        assertEquals(300, service.getPermissionDialogTimeoutSeconds());
    }

    @Test
    public void persistsClampedPermissionDialogTimeout() throws Exception {
        Path tempHome = Files.createTempDirectory("permission-timeout-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setPermissionDialogTimeoutSeconds(1);
        assertEquals(30, service.getPermissionDialogTimeoutSeconds());

        JsonObject config = service.readConfig();
        assertEquals(30, config.get("permissionDialogTimeoutSeconds").getAsInt());
    }

    @Test
    public void defaultsAutoCloseDialogOnTimeoutToTrueWhenMissing() throws Exception {
        Path tempHome = Files.createTempDirectory("auto-close-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertTrue(service.getAutoCloseDialogOnTimeout());
    }

    @Test
    public void persistsAutoCloseDialogOnTimeout() throws Exception {
        Path tempHome = Files.createTempDirectory("auto-close-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setAutoCloseDialogOnTimeout(false);
        assertFalse(service.getAutoCloseDialogOnTimeout());

        JsonObject config = service.readConfig();
        assertFalse(config.get("autoCloseDialogOnTimeout").getAsBoolean());
    }

    @Test
    public void resolvePermissionSafetyNetMsReturnsTimeoutPlusBufferWhenAutoCloseEnabled() throws Exception {
        Path tempHome = Files.createTempDirectory("safety-net-enabled-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setPermissionDialogTimeoutSeconds(120);
        service.setAutoCloseDialogOnTimeout(true);

        assertEquals(180_000L, PermissionDialogTimeoutSettings.resolvePermissionSafetyNetMs(service));
    }

    @Test
    public void resolvePermissionSafetyNetMsReturnsZeroSentinelWhenAutoCloseDisabled() throws Exception {
        Path tempHome = Files.createTempDirectory("safety-net-disabled-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setPermissionDialogTimeoutSeconds(120);
        service.setAutoCloseDialogOnTimeout(false);

        // 0 is the "wait indefinitely" sentinel handed to the Node bridge.
        assertEquals(0L, PermissionDialogTimeoutSettings.resolvePermissionSafetyNetMs(service));
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
