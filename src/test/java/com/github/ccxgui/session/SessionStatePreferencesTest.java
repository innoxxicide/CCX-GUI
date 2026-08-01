package com.github.ccxgui.session;

import org.junit.Assert;
import org.junit.Test;

/**
 * Covers the "was this preference actually chosen?" bookkeeping on
 * {@link SessionState}.
 *
 * <p>Regression: the webview treats a backend-supplied provider/model as an
 * authoritative per-tab preference that outranks its own remembered selection.
 * A fresh session still reports the placeholder provider/model, so without the
 * explicit-set flags every newly opened tab was reset to the default model —
 * and, through ReasoningSelect's level clamp, to a default reasoning effort.
 */
public class SessionStatePreferencesTest {

    @Test
    public void freshStateReportsPlaceholdersAsNotExplicitlySet() {
        SessionState state = new SessionState();

        Assert.assertEquals(SessionState.DEFAULT_PROVIDER, state.getProvider());
        Assert.assertEquals(SessionState.DEFAULT_MODEL, state.getModel());
        Assert.assertFalse(state.isProviderExplicitlySet());
        Assert.assertFalse(state.isModelExplicitlySet());
        Assert.assertNull(state.getReasoningEffort());
    }

    @Test
    public void settingProviderOrModelMarksItExplicit() {
        SessionState state = new SessionState();

        state.setModel("claude-opus-5");
        Assert.assertTrue(state.isModelExplicitlySet());
        Assert.assertFalse(state.isProviderExplicitlySet());

        state.setProvider("codex");
        Assert.assertTrue(state.isProviderExplicitlySet());
    }

    @Test
    public void settingTheSameValueAsTheDefaultStillCountsAsAChoice() {
        // A user who deliberately picks the default model must keep it when a new
        // tab is opened, so an explicit set of the placeholder value is explicit.
        SessionState state = new SessionState();

        state.setModel(SessionState.DEFAULT_MODEL);

        Assert.assertTrue(state.isModelExplicitlySet());
    }

    @Test
    public void blankValuesDoNotMarkAnythingExplicit() {
        SessionState state = new SessionState();

        state.setModel("   ");
        state.setProvider(null);

        Assert.assertFalse(state.isModelExplicitlySet());
        Assert.assertFalse(state.isProviderExplicitlySet());
    }

    @Test
    public void copyPreferencesCarriesValuesAndReasoningEffort() {
        SessionState source = new SessionState();
        source.setProvider("codex");
        source.setModel("gpt-5.6-sol");
        source.setPermissionMode("acceptEdits");
        source.setReasoningEffort("xhigh");

        SessionState target = new SessionState();
        target.copyPreferencesFrom(source);

        Assert.assertEquals("codex", target.getProvider());
        Assert.assertEquals("gpt-5.6-sol", target.getModel());
        Assert.assertEquals("acceptEdits", target.getPermissionMode());
        Assert.assertEquals("xhigh", target.getReasoningEffort());
        Assert.assertTrue(target.isProviderExplicitlySet());
        Assert.assertTrue(target.isModelExplicitlySet());
    }

    @Test
    public void copyPreferencesKeepsAnUnconfiguredSourceUnconfigured() {
        // A tab opened from a tab nobody configured must not start advertising the
        // placeholder default as a real per-tab selection.
        SessionState target = new SessionState();

        target.copyPreferencesFrom(new SessionState());

        Assert.assertEquals(SessionState.DEFAULT_PROVIDER, target.getProvider());
        Assert.assertEquals(SessionState.DEFAULT_MODEL, target.getModel());
        Assert.assertFalse(target.isProviderExplicitlySet());
        Assert.assertFalse(target.isModelExplicitlySet());
    }

    @Test
    public void copyPreferencesFromNullIsANoOp() {
        SessionState target = new SessionState();
        target.setModel("claude-opus-5");

        target.copyPreferencesFrom(null);

        Assert.assertEquals("claude-opus-5", target.getModel());
        Assert.assertTrue(target.isModelExplicitlySet());
    }
}
