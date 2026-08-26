package com.github.ccxgui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class SessionSendServiceTest {

    @Test
    public void normalizeRequestedPermissionModeRejectsBlankAndUnknownValues() {
        assertNull(SessionSendService.normalizeRequestedPermissionMode(null));
        assertNull(SessionSendService.normalizeRequestedPermissionMode(" "));
        assertNull(SessionSendService.normalizeRequestedPermissionMode("dangerouslyAllowEverything"));
    }

    @Test
    public void resolveEffectivePermissionModePrefersRequestedModeWhenValid() {
        assertEquals(
                "acceptEdits",
                SessionSendService.resolveEffectivePermissionMode("claude", "acceptEdits", "default")
        );
    }

    @Test
    public void resolveEffectivePermissionModeFallsBackToSessionModeAndDowngradesCodexPlan() {
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("codex", null, "plan")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("claude", null, null)
        );
    }

    @Test
    public void resolveEffectivePermissionModeDowngradesPlanForCliProviders() {
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("grok", "plan", "acceptEdits")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("kimi", "plan", null)
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("opencode", null, "plan")
        );
    }

    @Test
    public void resolveEffectivePermissionModePreservesBypassForGrokFullAuto() {
        // Regression: UI "全自动" (bypassPermissions) must survive resolution so
        // MarkerCliBridge can pass it into Grok ACP auto-approve — otherwise every
        // edit/tool still pops the permission dialog under default mode.
        assertEquals(
                "bypassPermissions",
                SessionSendService.resolveEffectivePermissionMode("grok", "bypassPermissions", "default")
        );
        assertEquals(
                "bypassPermissions",
                SessionSendService.resolveEffectivePermissionMode("grok", null, "bypassPermissions")
        );
        assertEquals(
                "acceptEdits",
                SessionSendService.resolveEffectivePermissionMode("grok", "acceptEdits", null)
        );
    }

    @Test
    public void normalizeCliModelForProviderMapsSentinelsAndGrokLegacyIds() {
        assertNull(SessionSendService.normalizeCliModelForProvider("kimi", "auto"));
        assertNull(SessionSendService.normalizeCliModelForProvider("opencode", "opencode-default"));
        assertEquals("kimi-k2.5", SessionSendService.normalizeCliModelForProvider("kimi", "kimi-k2.5"));
        assertEquals("grok-4.6", SessionSendService.normalizeCliModelForProvider("grok", "grok-4.6"));
        assertEquals("grok-4.6", SessionSendService.normalizeCliModelForProvider("grok", "grok-4.5"));
        assertEquals("grok-4.6", SessionSendService.normalizeCliModelForProvider("grok", "grok"));
        assertNull(SessionSendService.normalizeCliModelForProvider("grok", "claude-sonnet-5"));
    }

    @Test
    public void normalizeRequestedReasoningEffortRejectsBlankAndUnknownValues() {
        assertNull(SessionSendService.normalizeRequestedReasoningEffort(null));
        assertNull(SessionSendService.normalizeRequestedReasoningEffort(" "));
        assertNull(SessionSendService.normalizeRequestedReasoningEffort("extreme"));
        assertEquals("low", SessionSendService.normalizeRequestedReasoningEffort(" low "));
        assertEquals("xhigh", SessionSendService.normalizeRequestedReasoningEffort("xhigh"));
        assertEquals("max", SessionSendService.normalizeRequestedReasoningEffort("max"));
    }

    @Test
    public void getCodexRuntimeAccessErrorRequiresAuthorizationOrManagedProvider() {
        assertEquals(
                "Codex local configuration access is not authorized. Please authorize local ~/.codex access or enable a managed Codex provider first.",
                SessionSendService.getCodexRuntimeAccessError("inactive")
        );
        assertNull(SessionSendService.getCodexRuntimeAccessError("managed"));
        assertNull(SessionSendService.getCodexRuntimeAccessError("cli_login"));
    }

    @Test
    public void composeProviderInputAppendsContextAndAgentRoleWhenConciseModeIsOff() {
        assertEquals(
                "fix this\n\n## IDE Context\n\nActive file: `A.java`"
                        + "\n\n## Agent Role and Instructions\n\nYou are a reviewer.",
                SessionSendService.composeProviderInput(
                        "fix this",
                        "\n\n## IDE Context\n\nActive file: `A.java`",
                        "You are a reviewer.",
                        false
                )
        );
    }

    @Test
    public void composeProviderInputSendsOnlyTheUserMessageInConciseMode() {
        // Regression: concise mode was honored on the Claude path only, so Codex and
        // every marker CLI provider still received the plugin's own context block and
        // agent-role wrapper on every turn.
        assertEquals(
                "fix this",
                SessionSendService.composeProviderInput(
                        "fix this",
                        "\n\n## IDE Context\n\nActive file: `A.java`",
                        "You are a reviewer.",
                        true
                )
        );
        assertEquals("", SessionSendService.composeProviderInput(null, "ctx", "role", true));
    }

    @Test
    public void newSessionStateDoesNotInjectDefaultClaudeReasoningEffort() {
        SessionState state = new SessionState();

        assertNull(state.getReasoningEffort());
    }

    @Test
    public void normalizeRequestedCodexServiceTierMapsFastAliasesOnly() {
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.normalizeRequestedCodexServiceTier("fast")
        );
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.normalizeRequestedCodexServiceTier("priority")
        );
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier("normal"));
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier("standard"));
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier(""));
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier("experimental-tier"));
    }

    @Test
    public void resolveEffectiveCodexServiceTierDoesNotSendTierForNormalMode() {
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier("normal", null));
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier("standard", "fast"));
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier("default", "priority"));
    }

    @Test
    public void resolveEffectiveCodexServiceTierFallsBackToSessionTierWhenNoRequestedMode() {
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.resolveEffectiveCodexServiceTier(null, "fast")
        );
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.resolveEffectiveCodexServiceTier(null, "priority")
        );
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier(null, "normal"));
    }
}
