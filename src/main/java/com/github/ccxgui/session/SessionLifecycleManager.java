package com.github.ccxgui.session;

import com.github.ccxgui.bridge.NodeDetector;
import com.github.ccxgui.i18n.ClaudeCodeGuiBundle;
import com.github.ccxgui.model.SessionTemplate;
import com.github.ccxgui.settings.CodemossSettingsService;
import com.github.ccxgui.handler.UsagePushService;
import com.github.ccxgui.handler.core.HandlerContext;
import com.github.ccxgui.provider.claude.ClaudeSDKBridge;
import com.github.ccxgui.provider.codex.CodexSDKBridge;
import com.github.ccxgui.provider.common.MarkerCliBridge;
import com.github.ccxgui.skill.SlashCommandRegistry;
import com.github.ccxgui.util.JsUtils;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;

import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Manages session lifecycle operations: creation, history loading,
 * working directory resolution, slash commands, and permission mode sync.
 */
public class SessionLifecycleManager {

    private static final Logger LOG = Logger.getInstance(SessionLifecycleManager.class);
    private static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";

    /**
     * Host interface providing access to window-level dependencies.
     */
    public interface SessionHost {
        Project getProject();

        ClaudeSDKBridge getClaudeSDKBridge();

        CodexSDKBridge getCodexSDKBridge();

        Map<String, MarkerCliBridge> getCliBridges();

        ClaudeSession getSession();

        void setSession(ClaudeSession session);

        HandlerContext getHandlerContext();

        StreamMessageCoalescer getStreamCoalescer();

        void clearPendingPermissionRequests();

        void clearPermissionDecisionMemory();

        void callJavaScript(String functionName, String... args);

        boolean isDisposed();

        JBCefBrowser getBrowser();

        void setupSessionCallbacks();

        void invalidateSessionCallbacks();

        void setSlashCommandsFetched(boolean fetched);

        void setFetchedSlashCommandsCount(int count);
    }

    private final SessionHost host;

    public SessionLifecycleManager(SessionHost host) {
        this.host = host;
    }

    /**
     * Create a new session, interrupting the old one first.
     */
    public void createNewSession() {
        LOG.info("Creating new session...");

        ClaudeSession oldSession = host.getSession();
        // Snapshot the preferences to carry over. Detached from the old session so
        // the copy is unaffected by anything that mutates it while the interrupt
        // below is in flight.
        SessionState previousPreferences = new SessionState();
        if (oldSession != null) {
            previousPreferences.copyPreferencesFrom(oldSession.getState());
        }
        String previousPermissionMode = previousPreferences.getPermissionMode();
        LOG.info("Preserving session state: mode=" + previousPermissionMode
                         + ", provider=" + previousPreferences.getProvider()
                         + ", model=" + previousPreferences.getModel()
                         + ", reasoningEffort=" + previousPreferences.getReasoningEffort());

        host.invalidateSessionCallbacks();
        long clearBarrierSeq = host.getStreamCoalescer().resetStreamState();
        host.callJavaScript("clearMessages", String.valueOf(clearBarrierSeq));

        CompletableFuture<Void> interruptFuture = oldSession != null
                                                          ? oldSession.interrupt()
                                                          : CompletableFuture.completedFuture(null);

        interruptFuture.thenRun(() -> {
            if (oldSession != null) {
                host.getClaudeSDKBridge().resetPersistentRuntime(oldSession.getRuntimeSessionEpoch());
                LOG.info("[Lifecycle] Requested daemon runtime reset for old epoch=" + oldSession.getRuntimeSessionEpoch());
            }
            LOG.info("Old session interrupted, creating new session");

            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("onStreamEnd");
                host.callJavaScript("showLoading", "false");
            });

            ClaudeSession newSession = createDefaultSession();
            newSession.getState().copyPreferencesFrom(previousPreferences);
            // Routed through the session (not the state) so the PermissionManager
            // is synced along with the stored mode.
            newSession.setPermissionMode(previousPermissionMode);
            LOG.info("Restored session state to new session: mode=" + previousPermissionMode
                             + ", provider=" + newSession.getProvider()
                             + ", model=" + newSession.getModel()
                             + ", reasoningEffort=" + newSession.getReasoningEffort());

            completeNewSessionBootstrap(newSession, determineWorkingDirectory(),
                    "New session created successfully, working directory: ");
        }).exceptionally(ex -> {
            LOG.error("Failed to create new session: " + ex.getMessage(), ex);
            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("historyLoadComplete");
                host.callJavaScript("updateStatus",
                        JsUtils.escapeJs("Failed to create new session: " + ex.getMessage()));
            });
            return null;
        });
    }

    /**
     * Create a new session from a template, interrupting the old one first.
     */
    public void createNewSessionFromTemplate(SessionTemplate template) {
        LOG.info("Creating new session from template: " + template.getName());

        ClaudeSession oldSession = host.getSession();

        host.invalidateSessionCallbacks();
        long clearBarrierSeq = host.getStreamCoalescer().resetStreamState();
        host.callJavaScript("clearMessages", String.valueOf(clearBarrierSeq));

        CompletableFuture<Void> interruptFuture = oldSession != null
                ? oldSession.interrupt()
                : CompletableFuture.completedFuture(null);

        interruptFuture.thenRun(() -> {
            if (oldSession != null) {
                host.getClaudeSDKBridge().resetPersistentRuntime(oldSession.getRuntimeSessionEpoch());
                LOG.info("[Lifecycle] Requested daemon runtime reset for old epoch=" + oldSession.getRuntimeSessionEpoch());
            }
            LOG.info("Old session interrupted, creating new session from template");

            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("onStreamEnd");
                host.callJavaScript("showLoading", "false");
            });

            ClaudeSession newSession = createDefaultSession();

            // Apply template settings
            if (template.getPermissionMode() != null) {
                newSession.setPermissionMode(template.getPermissionMode());
            }
            if (template.getProvider() != null) {
                newSession.setProvider(template.getProvider());
            }
            if (template.getModel() != null) {
                newSession.setModel(template.getModel());
            }
            if (template.getReasoningEffort() != null) {
                newSession.setReasoningEffort(template.getReasoningEffort());
            }
            newSession.getState().setPsiContextEnabled(template.isPsiContextEnabled());

            LOG.info("Applied template settings to new session: provider=" + template.getProvider()
                    + ", model=" + template.getModel() + ", mode=" + template.getPermissionMode());

            String workingDirectory = template.getCwd() != null && !template.getCwd().trim().isEmpty()
                    ? template.getCwd() : determineWorkingDirectory();
            completeNewSessionBootstrap(newSession, workingDirectory,
                    "New session created from template successfully, working directory: ");
        }).exceptionally(ex -> {
            LOG.error("Failed to create new session from template: " + ex.getMessage(), ex);
            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("historyLoadComplete");
                host.callJavaScript("updateStatus",
                        JsUtils.escapeJs("Failed to create new session from template: " + ex.getMessage()));
            });
            return null;
        });
    }

    /**
     * Load a history session by ID.
     */
    public void loadHistorySession(String sessionId, String projectPath) {
        loadHistorySession(sessionId, projectPath, null, null);
    }

    /**
     * Load a history session by ID and provider.
     */
    public void loadHistorySession(String sessionId, String projectPath, String provider) {
        loadHistorySession(sessionId, projectPath, provider, null);
    }

    /**
     * Load a history session by ID, provider, and optional model from the history row.
     *
     * @param model when non-blank, restores that model instead of keeping the previous UI selection
     */
    public void loadHistorySession(String sessionId, String projectPath, String provider, String model) {
        LOG.info("Loading history session: " + sessionId + " from project: " + projectPath);

        ClaudeSession oldSession = host.getSession();
        // Snapshot the preferences to carry over (see createNewSession).
        SessionState previousPreferences = new SessionState();
        String previousPermissionMode;

        if (oldSession != null) {
            previousPreferences.copyPreferencesFrom(oldSession.getState());
            previousPermissionMode = previousPreferences.getPermissionMode();
        } else {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
            previousPermissionMode = (savedMode != null && !savedMode.trim().isEmpty())
                                             ? savedMode.trim() : previousPreferences.getPermissionMode();
        }
        String modelToRestore = (model != null && !model.trim().isEmpty())
                ? model.trim() : previousPreferences.getModel();
        LOG.info("Preserving session state when loading history: mode=" + previousPermissionMode
                         + ", provider=" + previousPreferences.getProvider()
                         + ", model=" + previousPreferences.getModel()
                         + ", reasoningEffort=" + previousPreferences.getReasoningEffort());

        host.invalidateSessionCallbacks();
        long clearBarrierSeq = host.getStreamCoalescer().resetStreamState();
        host.callJavaScript("clearMessages", String.valueOf(clearBarrierSeq));
        host.clearPendingPermissionRequests();
        host.clearPermissionDecisionMemory();

        CompletableFuture<Void> interruptFuture = oldSession != null
                ? oldSession.interrupt()
                : CompletableFuture.completedFuture(null);

        interruptFuture.thenRun(() -> {
            if (oldSession != null) {
                host.getClaudeSDKBridge().resetPersistentRuntime(oldSession.getRuntimeSessionEpoch());
                LOG.info("[Lifecycle] Requested daemon runtime reset before history load for old epoch="
                        + oldSession.getRuntimeSessionEpoch());
            }

            ClaudeSession newSession = new ClaudeSession(
                    host.getProject(),
                    host.getClaudeSDKBridge(),
                    host.getCodexSDKBridge(),
                    host.getCliBridges());
            newSession.getState().copyPreferencesFrom(previousPreferences);
            // Routed through the session (not the state) so the PermissionManager
            // is synced along with the stored mode.
            newSession.setPermissionMode(previousPermissionMode);
            if (provider != null && !provider.trim().isEmpty()) {
                newSession.setProvider(provider);
            }
            // A model carried on the history row outranks the copied preference, so
            // reopening an old session restores the model it actually ran with.
            newSession.setModel(modelToRestore);
            LOG.info("Restored session state to loaded session: mode=" + previousPermissionMode
                             + ", provider=" + newSession.getProvider()
                             + ", model=" + newSession.getModel()
                             + ", reasoningEffort=" + newSession.getReasoningEffort());

            host.setSession(newSession);
            host.getHandlerContext().setSession(newSession);
            host.setupSessionCallbacks();

            String workingDir = (projectPath != null && !projectPath.isEmpty())
                                    ? projectPath : NodeDetector.convertToWslPath(determineWorkingDirectory());
            newSession.setSessionInfo(sessionId, workingDir);

            // Prewarm daemon runtime for the historical session so /context and first message are fast
            host.getClaudeSDKBridge().prewarmDaemonAsync(workingDir, newSession.getRuntimeSessionEpoch(), sessionId);

            newSession.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
                // loadFromServer only enqueues updateMessages through the coalescer; if we
                // call historyLoadComplete immediately the frontend releases the transition
                // guard before the snapshot arrives (or a reordered clearMessages can wipe a
                // stashed snapshot). Flush the coalescer first so messages land before complete.
                completeHistoryLoadAfterCoalescerFlush(newSession);
            })).exceptionally(ex -> {
                ApplicationManager.getApplication().invokeLater(() -> {
                    // Release transition guard so the frontend is not permanently stuck
                    host.callJavaScript("historyLoadComplete");
                    host.callJavaScript("addErrorMessage",
                            JsUtils.escapeJs("Failed to load session: " + ex.getMessage()));
                });
                return null;
            });
        }).exceptionally(ex -> {
            LOG.error("Failed to load history session: " + ex.getMessage(), ex);
            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("historyLoadComplete");
                host.callJavaScript("addErrorMessage",
                        JsUtils.escapeJs("Failed to load session: " + ex.getMessage()));
            });
            return null;
        });
    }

    /**
     * Push any pending coalesced message snapshot to the webview, then signal
     * {@code historyLoadComplete} with the message count. Ensures the transcript
     * is not lost when the frontend holds {@code __sessionTransitioning} until complete.
     */
    private void completeHistoryLoadAfterCoalescerFlush(ClaudeSession loadedSession) {
        if (host.isDisposed()) {
            return;
        }
        int messageCount = loadedSession != null ? loadedSession.getMessages().size() : 0;
        StreamMessageCoalescer coalescer = host.getStreamCoalescer();
        if (coalescer == null) {
            host.callJavaScript("historyLoadComplete", String.valueOf(messageCount));
            return;
        }
        coalescer.flush(seq -> {
            if (!host.isDisposed()) {
                host.callJavaScript("historyLoadComplete", String.valueOf(messageCount));
            }
        });
    }

    /**
     * Determine the working directory for the session.
     */
    public String determineWorkingDirectory() {
        String projectPath = host.getProject().getBasePath();

        if (projectPath == null || !new File(projectPath).exists()) {
            String userHome = NodeDetector.resolveHomeForFileOps();
            LOG.warn("Using user home directory as fallback: " + userHome);
            return userHome;
        }

        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            // Normalized effective working directory (custom dir if valid, else the
            // project path). Collapsing relative segments here keeps the launched cwd
            // consistent with the directory history is read from.
            String resolvedPath = settingsService.getEffectiveWorkingDirectory(projectPath);
            if (resolvedPath != null && !resolvedPath.isEmpty()) {
                LOG.info("Using working directory: " + resolvedPath);
                return resolvedPath;
            }
        } catch (Exception e) {
            LOG.warn("Failed to resolve working directory: " + e.getMessage());
        }

        return projectPath;
    }

    /**
     * Fetch slash commands using local registry (no SDK/API call needed).
     * Merges built-in commands with skill-derived commands per provider.
     */
    public void fetchSlashCommandsOnStartup() {
        ClaudeSession currentSession = host.getSession();
        String cwd = currentSession != null ? currentSession.getCwd() : null;
        if (cwd == null) {
            cwd = host.getProject().getBasePath();
        }

        // Determine current provider
        String provider = "claude";
        if (currentSession != null && currentSession.getProvider() != null) {
            provider = currentSession.getProvider();
        }

        LOG.info("Fetching slash commands locally, provider=" + provider + ", cwd=" + cwd);

        String currentFilePath = getCurrentEditorFilePath();
        var commands = SlashCommandRegistry.getCommands(provider, cwd, currentFilePath);
        String commandsJson = SlashCommandRegistry.toJson(commands);

        host.setFetchedSlashCommandsCount(commands.size());
        host.setSlashCommandsFetched(true);
        LOG.info("Slash commands resolved locally: " + commands.size() + " commands");

        // Pre-compute Codex skills outside EDT to avoid file I/O on UI thread
        final List<SlashCommandRegistry.SlashCommand> codexSkills;
        final String codexSkillsJson;
        if ("codex".equalsIgnoreCase(provider)) {
            codexSkills = SlashCommandRegistry.getCodexSkills(cwd);
            codexSkillsJson = SlashCommandRegistry.toJson(codexSkills);
            LOG.info("Codex skills resolved: " + codexSkills.size() + " skills");
        } else {
            codexSkills = null;
            codexSkillsJson = null;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                host.callJavaScript("updateSlashCommands", JsUtils.escapeJs(commandsJson));

                // Push Codex skills as separate channel for $ autocomplete
                if (codexSkillsJson != null) {
                    host.callJavaScript("window.updateDollarCommands", JsUtils.escapeJs(codexSkillsJson));
                }
            } catch (Exception e) {
                LOG.warn("Failed to send slash commands to frontend: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Send current permission mode to the frontend.
     */
    public void sendCurrentPermissionMode() {
        try {
            String currentMode = "default";

            ClaudeSession currentSession = host.getSession();
            if (currentSession != null) {
                String sessionMode = currentSession.getPermissionMode();
                if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                    currentMode = sessionMode;
                }
            }

            final String modeToSend = currentMode;

            ApplicationManager.getApplication().invokeLater(() -> {
                if (!host.isDisposed() && host.getBrowser() != null) {
                    host.callJavaScript("window.onModeReceived", JsUtils.escapeJs(modeToSend));
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to send current permission mode: " + e.getMessage(), e);
        }
    }

    /**
     * Clear transient context usage after creating a new session. The new provider has
     * not reported a trusted token count yet, so used/max values remain unknown.
     */
    private void resetTokenUsage() {
        new UsagePushService(host.getHandlerContext()).clearUsageDisplay();
    }

    private String getCurrentEditorFilePath() {
        return com.github.ccxgui.util.EditorFileUtils.getCurrentEditorFilePath(this.host.getProject());
    }

    private ClaudeSession createDefaultSession() {
        return new ClaudeSession(
                host.getProject(),
                host.getClaudeSDKBridge(),
                host.getCodexSDKBridge(),
                host.getCliBridges());
    }

    private void completeNewSessionBootstrap(ClaudeSession newSession, String workingDirectory, String successLogPrefix) {
        host.clearPendingPermissionRequests();
        host.clearPermissionDecisionMemory();
        host.setSession(newSession);
        host.getHandlerContext().setSession(newSession);
        host.setupSessionCallbacks();

        newSession.setSessionInfo(null, workingDirectory);
        LOG.info(successLogPrefix + workingDirectory + ", epoch=" + newSession.getRuntimeSessionEpoch());
        host.getClaudeSDKBridge().prewarmDaemonAsync(workingDirectory, newSession.getRuntimeSessionEpoch());
        fetchSlashCommandsOnStartup();

        ApplicationManager.getApplication().invokeLater(() -> {
            // Release the frontend session transition guard so updateMessages works again.
            // Must come BEFORE updateStatus to ensure the guard is lifted before any
            // subsequent message updates arrive.
            host.callJavaScript("historyLoadComplete");
            host.callJavaScript("updateStatus",
                    JsUtils.escapeJs(ClaudeCodeGuiBundle.message("toast.newSessionCreatedReady")));
            resetTokenUsage();
        });
    }
}
