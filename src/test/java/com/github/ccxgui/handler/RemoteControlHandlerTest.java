package com.github.ccxgui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link RemoteControlHandler} request parsing.
 */
public class RemoteControlHandlerTest {

    private static final Gson GSON = new Gson();

    @Test
    public void parseReadsBothFields() {
        JsonObject body = new JsonObject();
        body.addProperty("enabled", true);
        body.addProperty("name", "planner");

        RemoteControlHandler.RemoteControlRequest request =
                RemoteControlHandler.parseRemoteControlRequest(GSON, body.toString());

        assertTrue(request.enabled);
        assertEquals("planner", request.name);
    }

    @Test
    public void parseKeepsTheOffRequestOff() {
        JsonObject body = new JsonObject();
        body.addProperty("enabled", false);

        RemoteControlHandler.RemoteControlRequest request =
                RemoteControlHandler.parseRemoteControlRequest(GSON, body.toString());

        assertFalse("an unreadable off request would silently keep the session exposed", request.enabled);
        assertNull(request.name);
    }

    @Test
    public void parseFallsBackToEnableOnUnreadableBody() {
        RemoteControlHandler.RemoteControlRequest request =
                RemoteControlHandler.parseRemoteControlRequest(GSON, "not valid json {{{");

        assertTrue(request.enabled);
        assertNull(request.name);
    }

    @Test
    public void parseFallsBackToEnableOnEmptyBody() {
        RemoteControlHandler.RemoteControlRequest request =
                RemoteControlHandler.parseRemoteControlRequest(GSON, "");

        assertTrue(request.enabled);
        assertNull(request.name);
    }
}
