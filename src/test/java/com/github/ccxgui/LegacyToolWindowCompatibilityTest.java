package com.github.ccxgui;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class LegacyToolWindowCompatibilityTest {

    @Test
    public void legacyToolWindowClassRemainsAssignableToCurrentImplementation() {
        assertTrue(
            com.github.ccxgui.ui.toolwindow.ClaudeSDKToolWindow.class
                .isAssignableFrom(ClaudeSDKToolWindow.class)
        );
    }
}
