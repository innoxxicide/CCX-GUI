package com.github.ccxgui.cli;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class CliToolIdTest {

    @Test
    public void fromId_acceptsKnownTools() {
        assertEquals(CliToolId.GROK, CliToolId.fromId("grok"));
        assertEquals(CliToolId.KIMI, CliToolId.fromId("KIMI"));
        assertEquals(CliToolId.OPENCODE, CliToolId.fromId(" opencode "));
        assertEquals(CliToolId.PI, CliToolId.fromId("pi"));
    }

    @Test
    public void fromId_rejectsUnknown() {
        assertNull(CliToolId.fromId(null));
        assertNull(CliToolId.fromId(""));
        assertNull(CliToolId.fromId("claude"));
    }

    @Test
    public void binaryNames_matchExpected() {
        assertEquals("grok", CliToolId.GROK.getBinaryName());
        assertEquals("kimi", CliToolId.KIMI.getBinaryName());
        assertEquals("opencode", CliToolId.OPENCODE.getBinaryName());
        assertEquals("pi", CliToolId.PI.getBinaryName());
        for (CliToolId tool : CliToolId.values()) {
            assertNotNull(tool.getDisplayName());
        }
    }
}
