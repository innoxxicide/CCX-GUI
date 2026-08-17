package com.github.ccxgui.ui.toolwindow;

import com.github.ccxgui.action.SendShortcutSync;
import com.github.ccxgui.handler.core.HandlerContext;
import com.github.ccxgui.handler.history.HistoryHandler;
import com.github.ccxgui.handler.core.MessageDispatcher;
import com.github.ccxgui.handler.PermissionHandler;
import com.github.ccxgui.permission.PermissionService;
import com.github.ccxgui.power.KeepAwakeService;
import com.github.ccxgui.provider.claude.ClaudeAutoResumeController;
import com.github.ccxgui.provider.claude.ClaudeSDKBridge;
import com.github.ccxgui.provider.codex.CodexSDKBridge;
import com.github.ccxgui.provider.common.DaemonBridge;
import com.github.ccxgui.provider.common.MessageCallback;
import com.github.ccxgui.schedule.ScheduledSendController;
import com.github.ccxgui.session.ClaudeSession;
import com.github.ccxgui.session.SessionCallbackAdapter;
import com.github.ccxgui.session.SessionLifecycleManager;
import com.github.ccxgui.session.SessionState;
import com.github.ccxgui.session.StreamMessageCoalescer;
import com.github.ccxgui.settings.CodemossSettingsService;
import com.github.ccxgui.settings.TabStateService;
import com.github.ccxgui.ui.ChatWindowDelegate;
import com.github.ccxgui.ui.EditorContextTracker;
import com.github.ccxgui.ui.WebviewInitializer;
import com.github.ccxgui.ui.WebviewWatchdog;
import com.github.ccxgui.ui.detached.DetachedChatFrame;
import com.github.ccxgui.ui.detached.DetachedWindowManager;
import com.github.ccxgui.util.HtmlLoader;
import com.github.ccxgui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.Alarm;
import org.cef.browser.CefBrowser;

import javax.swing.*;
import java.awt.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Chat window instance. Coordinates UI components, session management,
 * and message dispatching. One instance per tab.
 */
public class ClaudeChatWindow {

    private static final Logger LOG = Logger.getInstance(ClaudeChatWindow.class);

    private final JPanel mainPanel;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final Project project;
    private final CodemossSettingsService settingsService;
    private final HtmlLoader htmlLoader;

    private Content parentContent;
    private String originalTabName;
    private volatile String sessionId = null;
    // Stable PermissionService routing key, assigned once at construction.
    // Kept separate from sessionId, which is overwritten with AI session IDs
    // (onSessionIdReceived) and would otherwise break dispose-time cleanup and
    // clearPermissionDecisionMemory(), both of which must reach the instance
    // the bridges actually route permission requests to.
    private String permissionServiceKey = null;

    private volatile JBCefBrowser browser;
    // volatile: read from the daemon reader thread by the session_updated listener
    // and its loadFromServer continuation, while reassigned on the EDT.
    private volatile ClaudeSession session;
    private final WebviewWatchdog webviewWatchdog;
    private final StreamMessageCoalescer streamCoalescer;

    private volatile boolean disposed = false;
    private volatile boolean initialized = false;
    private volatile boolean frontendReady = false;
    private final PendingCodeSnippetBuffer pendingCodeSnippetBuffer = new PendingCodeSnippetBuffer();
    private volatile boolean slashCommandsFetched = false;
    private final AtomicBoolean restoredHistoryLoadStarted = new AtomicBoolean(false);

    // Daemon event listener for AI title forwarding. Held so it can be removed on dispose.
    private DaemonBridge.DaemonEventListener titleEventListener;
    private volatile int fetchedSlashCommandsCount = 0;

    // Coalesces session_updated reloads. SessionState's message list is not
    // thread-safe and loadFromServer() runs async, so concurrent background-task
    // completions must not reload at the same time. Guarded by sessionReloadLock.
    private final Object sessionReloadLock = new Object();
    private boolean sessionReloadInFlight = false;
    private boolean sessionReloadPending = false;
    // A session_updated reload that arrived while a turn was streaming is parked
    // here and drained at stream end (onStreamEnded). See {@link DeferredReload}.
    private final DeferredReload deferredReload = new DeferredReload();
    // Backstop for the parked reload. onStreamEnded is the fast drain path, but it
    // is edge-triggered: a defer that lands just after the stream-end edge (a
    // cross-thread check-then-act between the daemon reader's isStreamActive() read
    // and the stream reader's streamActive=false + drain), or the LAST background
    // answer of a fan-out with no following stream end, would otherwise never be
    // drained — the answer stays invisible forever. This alarm re-checks after a
    // short delay and drains the parked reload the moment the stream is idle,
    // without ever reloading mid-stream. Pooled thread: draining kicks off an async
    // loadFromServer() that reads JSONL, so it must not run on the EDT.
    private static final int DEFERRED_RELOAD_SAFETY_DRAIN_MS = 500;
    private final Disposable safetyAlarmDisposable =
            Disposer.newDisposable("ccgui-deferred-reload-safety");
    private final Alarm deferredReloadSafetyAlarm =
            new Alarm(Alarm.ThreadToUse.POOLED_THREAD, safetyAlarmDisposable);

    private HandlerContext handlerContext;
    // volatile: assigned once on the EDT during init, then read lock-free from the JCEF UI thread
    // in handleJavaScriptMessage. The read can no longer piggyback on the host monitor's visibility
    // now that handleJavaScriptMessage is unsynchronized, so the field carries its own happens-before.
    private volatile MessageDispatcher messageDispatcher;
    /**
     * Serializes webview message dispatch against {@link #dispose()}; see
     * {@link MessageDispatchGate} for the lifecycle contract.
     */
    private final MessageDispatchGate dispatchGate = new MessageDispatchGate();
    private PermissionHandler permissionHandler;
    private HistoryHandler historyHandler;
    private final SessionLifecycleManager sessionLifecycleManager;

    // Delegates
    private WebviewInitializer webviewInitializer;
    private final EditorContextTracker editorContextTracker;
    private final ChatWindowDelegate chatWindowDelegate;
    // Claude-only auto-resume after a usage-limit reset. Inert unless the feature
    // toggle is on and the bound session is Claude. One instance per window; its
    // Host reads the live session field so it survives session re-binding.
    private final ClaudeAutoResumeController autoResumeController;
    // User-scheduled "Send scheduled" delivery for this tab. Provider-agnostic and
    // idle until the user picks a time; like the controller above, its Host reads
    // the live session field so it survives session re-binding.
    private final ScheduledSendController scheduledSendController;
    // Text of a scheduled send that could not be delivered on time. Held so the
    // banner's "Send now" has something to send — the controller drops its own
    // copy when it disarms. volatile: written from the scheduler thread that
    // reports the miss, read on the EDT when the user clicks.
    private volatile String missedScheduledSendText = null;
    // volatile: read from the daemon reader thread by the task_event listener
    // (titleEventListener), while reassigned on the EDT in setupSessionCallbacks.
    // Without volatile a session switch could publish a new adapter on the EDT
    // that the daemon thread never observes, so a late task_notification would
    // route to the deactivated adapter and be dropped - leaving the subagent
    // stuck on "running".
    private volatile SessionCallbackAdapter sessionCallbackAdapter;

    // Keep-awake holds owned by this window. Three separate tokens because the
    // reasons to stay awake overlap in time and end independently: a turn can
    // finish (busy hold gone) while a usage-limit assessment is still in flight,
    // and that assessment can hand off to an armed wake that outlives both.
    // Identity is all that matters — KeepAwakeService compares tokens by reference.
    private final Object busyKeepAwakeToken = new Object();
    private final Object limitCheckKeepAwakeToken = new Object();
    private final Object autoResumeKeepAwakeToken = new Object();
    // A scheduled send has the same deadline problem as an armed auto-resume wake:
    // it does not fire on time if the machine idle-slept through it.
    private final Object scheduledSendKeepAwakeToken = new Object();

    public ClaudeChatWindow(Project project) {
        this(project, false);
    }

    public ClaudeChatWindow(Project project, boolean skipRegister) {
        this.project = project;
        this.claudeSDKBridge = new ClaudeSDKBridge();
        this.codexSDKBridge = new CodexSDKBridge();
        this.settingsService = new CodemossSettingsService();
        this.htmlLoader = new HtmlLoader(getClass());
        this.mainPanel = new JPanel(new BorderLayout());

        this.mainPanel.setBackground(com.github.ccxgui.util.ThemeConfigService.getBackgroundColor());

        this.streamCoalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                ClaudeChatWindow.this.callJavaScript(functionName, args);
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public void onStreamEnded() {
                ClaudeChatWindow.this.drainDeferredReload();
            }
        });

        this.webviewWatchdog = new WebviewWatchdog(
                mainPanel,
                () -> browser,
                () -> webviewInitializer.reloadWebview("watchdog_reload"),
                () -> webviewInitializer.recreateWebview("watchdog_recreate"),
                () -> disposed,
                () -> streamCoalescer.isStreamActive(),
                () -> frontendReady
        );

        this.session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);
        this.autoResumeController = new ClaudeAutoResumeController(createAutoResumeHost(), settingsService);
        this.scheduledSendController = new ScheduledSendController(createScheduledSendHost());

        this.chatWindowDelegate = new ChatWindowDelegate(createDelegateHost());
        chatWindowDelegate.loadPermissionModeFromSettings();
        chatWindowDelegate.loadNodePathFromSettings();
        chatWindowDelegate.syncActiveProvider();
        chatWindowDelegate.initializeHandlers();
        this.permissionServiceKey = chatWindowDelegate.setupPermissionService();
        this.sessionId = this.permissionServiceKey;

        this.sessionLifecycleManager = new SessionLifecycleManager(new SessionLifecycleManager.SessionHost() {
            @Override
            public Project getProject() {
                return project;
            }

            @Override
            public ClaudeSDKBridge getClaudeSDKBridge() {
                return claudeSDKBridge;
            }

            @Override
            public CodexSDKBridge getCodexSDKBridge() {
                return codexSDKBridge;
            }

            @Override
            public ClaudeSession getSession() {
                return session;
            }

            @Override
            public void setSession(ClaudeSession s) {
                session = s;
                persistTabSessionState();
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public StreamMessageCoalescer getStreamCoalescer() {
                return streamCoalescer;
            }

            @Override
            public void clearPendingPermissionRequests() {
                permissionHandler.clearPendingRequests();
            }

            @Override
            public void clearPermissionDecisionMemory() {
                try {
                    if (permissionServiceKey != null && !permissionServiceKey.isEmpty()) {
                        PermissionService permissionService = PermissionService.getInstance(project, permissionServiceKey);
                        permissionService.clearDecisionMemory();
                    }
                } catch (Exception e) {
                    LOG.warn("Failed to clear permission decision memory: " + e.getMessage());
                }
            }

            @Override
            public void callJavaScript(String fn, String... args) {
                ClaudeChatWindow.this.callJavaScript(fn, args);
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public void setupSessionCallbacks() {
                ClaudeChatWindow.this.setupSessionCallbacks();
            }

            @Override
            public void invalidateSessionCallbacks() {
                if (sessionCallbackAdapter != null) {
                    sessionCallbackAdapter.deactivate();
                }
            }

            @Override
            public void setSlashCommandsFetched(boolean fetched) {
                slashCommandsFetched = fetched;
            }

            @Override
            public void setFetchedSlashCommandsCount(int count) {
                fetchedSlashCommandsCount = count;
            }
        });

        this.editorContextTracker = new EditorContextTracker(project, new EditorContextTracker.ContextCallback() {
            @Override
            public void addSelectionInfo(String info) {
                callJavaScript("addSelectionInfo", info);
            }

            @Override
            public void clearSelectionInfo() {
                callJavaScript("clearSelectionInfo");
            }
        });
        editorContextTracker.registerListeners();

        this.webviewInitializer = new WebviewInitializer(createWebviewHost());

        setupSessionCallbacks();
        initializeSessionInfo();

        // Delay JCEF browser creation to avoid service initialization conflicts
        // during JBCefApp$Holder class init (ProxyMigrationService dependency).
        // Operations that depend on browser readiness are also deferred.
        ToolWindowManager.getInstance(this.project).invokeLater(() -> {
            if (!this.disposed) {
                this.webviewInitializer.createUIComponents();
                this.initialized = true;
                LOG.info("Window instance fully initialized, project: " + this.project.getName());
            }
        });

        if (!skipRegister) {
            registerInstance();
        }
        chatWindowDelegate.initializeStatusBar();
        SendShortcutSync.syncFromSettings();
    }

    // ==================== Public API ====================

    public void setParentContent(Content content) {
        if (this.parentContent != null && this.parentContent != content) {
            ClaudeSDKToolWindow.unregisterContentMapping(this.parentContent);
            LOG.debug("[MultiTab] Unregistered old Content -> ClaudeChatWindow mapping");
        }

        this.parentContent = content;
        if (content != null) {
            ClaudeSDKToolWindow.registerContentMapping(content, this);
            LOG.debug("[MultiTab] Registered Content -> ClaudeChatWindow mapping for: " + content.getDisplayName());

            if (this.originalTabName == null) {
                String displayName = content.getDisplayName();
                this.originalTabName = displayName.endsWith("...")
                        ? displayName.substring(0, displayName.length() - 3)
                        : displayName;
                LOG.debug("[TabLoading] Auto-initialized original tab name: " + this.originalTabName);
            }

            persistTabSessionState();
        }
    }

    public void setOriginalTabName(String name) {
        this.originalTabName = (name != null && name.endsWith("..."))
                ? name.substring(0, name.length() - 3)
                : name;
        LOG.debug("[TabLoading] Set original tab name: " + this.originalTabName);
    }

    public boolean isDisposed() {
        return disposed;
    }

    public boolean isInitialized() {
        return initialized;
    }

    public Content getParentContent() {
        return parentContent;
    }

    private boolean isActiveContent() {
        Content content = parentContent;
        ContentManager contentManager = content == null ? null : content.getManager();
        if (contentManager != null && contentManager.getIndexOfContent(content) >= 0) {
            return contentManager.getSelectedContent() == content;
        }
        DetachedChatFrame detachedFrame = DetachedWindowManager.getDetachedFrame(project, this);
        return detachedFrame == null || detachedFrame.isActive();
    }

    private void activateContent() {
        Runnable activation = () -> {
            if (disposed) {
                return;
            }
            Content content = parentContent;
            ContentManager contentManager = content == null ? null : content.getManager();
            if (contentManager != null && contentManager.getIndexOfContent(content) >= 0) {
                contentManager.setSelectedContent(content);
                ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                        .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
                if (toolWindow != null
                        && toolWindow.getContentManager() == contentManager
                        && !toolWindow.isActive()) {
                    toolWindow.activate(null);
                }
                return;
            }
            DetachedChatFrame detachedFrame = DetachedWindowManager.getDetachedFrame(project, this);
            if (detachedFrame != null) {
                detachedFrame.setVisible(true);
                detachedFrame.toFront();
                detachedFrame.requestFocus();
            }
        };
        if (SwingUtilities.isEventDispatchThread()) {
            activation.run();
        } else {
            ApplicationManager.getApplication().invokeLater(activation);
        }
    }

    public JPanel getContent() {
        return mainPanel;
    }

    /**
     * Restore the native JCEF surface after this content tab becomes active again.
     * Reloading is intentionally avoided so the tab keeps its in-memory React state.
     */
    public void onTabActivated() {
        Runnable repaint = () -> {
            if (disposed || !isSelectedContent()) {
                return;
            }
            webviewWatchdog.markTabActivated();

            JBCefBrowser currentBrowser = browser;
            if (currentBrowser != null) {
                try {
                    refreshActivatedWebview(
                            mainPanel,
                            currentBrowser.getComponent(),
                            currentBrowser.getCefBrowser(),
                            currentBrowser.isOffScreenRendering(),
                            () -> callJavaScript("window.onTabActivated")
                    );
                } catch (Exception | LinkageError e) {
                    LOG.warn("Failed to refresh activated JCEF tab: " + e.getMessage(), e);
                }
            }
        };

        // selectionChanged runs before ContentManager fully remaps the heavyweight
        // JCEF child. Waiting one EDT turn is essential for empty tabs because they
        // have no later DOM update that would incidentally repaint the native surface.
        ApplicationManager.getApplication().invokeLater(repaint);
    }

    private boolean isSelectedContent() {
        Content content = parentContent;
        ContentManager contentManager = content == null ? null : content.getManager();
        return contentManager != null && contentManager.getSelectedContent() == content;
    }

    static void refreshActivatedWebview(
            JPanel mainPanel,
            JComponent browserComponent,
            CefBrowser cefBrowser,
            boolean offScreenRendering,
            Runnable frontendRepaint
    ) {
        mainPanel.revalidate();
        mainPanel.repaint();
        browserComponent.revalidate();
        browserComponent.repaint();

        try {
            if (offScreenRendering) {
                int width = browserComponent.getWidth();
                int height = browserComponent.getHeight();
                if (width > 0 && height > 0) {
                    cefBrowser.wasResized(width, height);
                }
            } else {
                Component nativeComponent = cefBrowser.getUIComponent();
                if (nativeComponent != null) {
                    nativeComponent.setVisible(false);
                    nativeComponent.invalidate();
                    nativeComponent.setVisible(true);
                    Container parent = nativeComponent.getParent();
                    if (parent != null) {
                        parent.validate();
                        parent.repaint();
                    }
                    nativeComponent.repaint();
                }
            }
            cefBrowser.notifyScreenInfoChanged();
        } finally {
            frontendRepaint.run();
        }
    }

    public ClaudeSDKBridge getClaudeSDKBridge() {
        return claudeSDKBridge;
    }

    public CodexSDKBridge getCodexSDKBridge() {
        return codexSDKBridge;
    }

    /**
     * Get the project associated with this chat window.
     *
     * @return the current project.
     */
    public Project getProject() {
        return this.project;
    }

    public String getSessionId() {
        return sessionId;
    }

    /**
     * Returns the provider this tab is currently using ("claude" or "codex").
     * Used by NodeProcessRegistry to label processes with the user-facing provider
     * rather than the underlying SDK type (a Claude daemon may still be alive
     * after the user switched the tab to Codex — the panel reflects the tab's
     * intent, not the lingering SDK).
     */
    public String getCurrentProvider() {
        HandlerContext ctx = this.handlerContext;
        return ctx != null ? ctx.getCurrentProvider() : "claude";
    }

    public ClaudeSession getSession() {
        return session;
    }

    /**
     * Copies provider-specific preferences into a newly-created tab without
     * carrying over the source tab's conversation or runtime channel.
     */
    public void inheritSessionPreferencesFrom(ClaudeChatWindow sourceWindow) {
        if (sourceWindow == null || sourceWindow.session == null || session == null) {
            return;
        }

        ClaudeSession sourceSession = sourceWindow.session;
        copySessionPreferences(sourceSession.getState(), session.getState());
        if (handlerContext != null) {
            handlerContext.setCurrentProvider(sourceSession.getProvider());
            handlerContext.setCurrentModel(sourceSession.getModel());
        }
        persistTabSessionState();
    }

    static void copySessionPreferences(SessionState source, SessionState target) {
        // Carries the "explicitly set" flags too, so a new tab opened from a tab
        // that was never configured does not present the placeholder default to
        // the webview as a real per-tab selection.
        target.copyPreferencesFrom(source);
    }

    public SessionLifecycleManager getSessionLifecycleManager() {
        return sessionLifecycleManager;
    }

    public void restorePersistedTabSessionState(TabStateService.TabSessionState savedState) {
        if (savedState == null || session == null) {
            return;
        }

        if (savedState.permissionMode != null && !savedState.permissionMode.trim().isEmpty()) {
            session.setPermissionMode(savedState.permissionMode);
        }
        if (savedState.provider != null && !savedState.provider.trim().isEmpty()) {
            session.setProvider(savedState.provider);
            // HandlerContext keeps its own currentProvider (read by
            // getCurrentProvider() and by handlers that don't go through the
            // session). Sync it here so the backend stays consistent until the
            // webview echoes its own provider selection — without this, the
            // very first message in a restored Codex tab still routes to the
            // Claude bridge until the frontend's localStorage hydration sends
            // set_provider, which itself can be wrong on multi-tab restarts
            // (issue #1353).
            if (handlerContext != null) {
                handlerContext.setCurrentProvider(savedState.provider);
            }
        }
        if (savedState.model != null && !savedState.model.trim().isEmpty()) {
            session.setModel(savedState.model);
        }
        if (savedState.reasoningEffort != null && !savedState.reasoningEffort.trim().isEmpty()) {
            session.setReasoningEffort(savedState.reasoningEffort);
        }

        String restoredSessionId = isNonEmpty(savedState.sessionId) ? savedState.sessionId : null;
        String restoredCwd = isNonEmpty(savedState.cwd) ? savedState.cwd : session.getCwd();
        session.setSessionInfo(restoredSessionId, restoredCwd);

        // Replay a persisted auto-resume wake before persisting below, so a still
        // valid wake is re-armed rather than overwritten with 0. Provider is set
        // above, so the controller's Claude/enabled gate reads correctly here.
        if (autoResumeController != null) {
            autoResumeController.restoreFromPersisted(savedState.claudeAutoResumeWakeAt);
        }
        // Same ordering reason as above: replay before persisting, or a still
        // pending scheduled send is overwritten with the empty snapshot below.
        if (scheduledSendController != null) {
            scheduledSendController.restoreFromPersisted(savedState.scheduledSendAt, savedState.scheduledSendText);
        }
        persistTabSessionState();

        LOG.info("[TabRestore] Restored tab session state: provider=" + savedState.provider
                + ", sessionId=" + savedState.sessionId + ", cwd=" + savedState.cwd + ")");
    }

    public void restorePersistedTabSessionState(TabStateService.TabSessionState savedState, boolean loadImmediately) {
        restorePersistedTabSessionState(savedState);
        if (TabSessionRestorePolicy.shouldLoadImmediately(savedState, loadImmediately)) {
            loadRestoredHistoryIfNeeded(savedState);
        }
    }

    public void loadRestoredHistoryIfNeeded() {
        if (session == null || !frontendReady) {
            return;
        }

        TabStateService.TabSessionState currentState = new TabStateService.TabSessionState();
        currentState.sessionId = session.getSessionId();
        loadRestoredHistoryIfNeeded(currentState);
    }

    private void loadRestoredHistoryIfNeeded(TabStateService.TabSessionState savedState) {
        if (!TabSessionRestorePolicy.shouldStartHistoryLoad(savedState, frontendReady) || session == null) {
            return;
        }
        if (!restoredHistoryLoadStarted.compareAndSet(false, true)) {
            return;
        }

        session.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            if (!disposed) {
                callJavaScript("historyLoadComplete");
            }
        })).exceptionally(ex -> {
            LOG.warn("[TabRestore] Failed to load persisted tab history: " + ex.getMessage(), ex);
            ApplicationManager.getApplication().invokeLater(() -> {
                if (!disposed) {
                    callJavaScript("historyLoadComplete");
                    callJavaScript("addErrorMessage",
                            JsUtils.escapeJs("Failed to restore session history: " + ex.getMessage()));
                }
            });
            return null;
        });
    }

    public void addCodeSnippetFromExternal(String selectionInfo) {
        if (selectionInfo == null || selectionInfo.isEmpty()) {
            return;
        }
        // offer() returns the snippet to emit now, or null when it was deferred
        // until the frontend signals readiness (see flushPendingCodeSnippet).
        String toEmit = pendingCodeSnippetBuffer.offer(selectionInfo, frontendReady);
        if (toEmit != null) {
            addCodeSnippet(toEmit);
        }
    }

    private void flushPendingCodeSnippet() {
        String snippet = pendingCodeSnippetBuffer.takePending();
        if (snippet != null) {
            addCodeSnippet(snippet);
        }
    }

    private void updateFrontendReadyState(boolean ready) {
        frontendReady = ready;
        if (!ready) {
            return;
        }
        flushPendingCodeSnippet();
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!disposed) {
                loadRestoredHistoryIfNeeded();
            }
        });
    }

    public void updateTabStatus(ChatWindowDelegate.TabAnswerStatus status) {
        chatWindowDelegate.updateTabStatus(status);
    }

    @Deprecated
    public void updateTabLoadingState(boolean loading) {
        chatWindowDelegate.updateTabLoadingState(loading);
    }

    public void sendQuickFixMessage(String prompt, boolean isQuickFix, MessageCallback callback) {
        chatWindowDelegate.sendQuickFixMessage(prompt, isQuickFix, callback);
    }

    public void executeJavaScriptCode(String jsCode) {
        JBCefBrowser targetBrowser = this.browser;
        if (this.disposed || targetBrowser == null) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (this.disposed || this.browser != targetBrowser) {
                return;
            }
            try {
                org.cef.browser.CefBrowser cefBrowser = targetBrowser.getCefBrowser();
                cefBrowser.executeJavaScript(jsCode, cefBrowser.getURL(), 0);
            } catch (Exception | LinkageError e) {
                LOG.warn("Failed to execute raw JS code: " + e.getMessage(), e);
            }
        });
    }

    // ==================== JavaScript Bridge ====================

    private static final java.util.regex.Pattern SAFE_JS_FUNCTION_NAME =
            java.util.regex.Pattern.compile("^[a-zA-Z_$][a-zA-Z0-9_$.]*$");

    void callJavaScript(String functionName, String... args) {
        JBCefBrowser targetBrowser = this.browser;
        if (this.disposed || targetBrowser == null) {
            LOG.warn("Cannot call JS function " + functionName + ": disposed=" + this.disposed
                    + ", browser=" + (targetBrowser == null ? "null" : "exists"));
            return;
        }

        if (functionName == null || !SAFE_JS_FUNCTION_NAME.matcher(functionName).matches()) {
            LOG.error("Invalid JavaScript function name rejected: " + functionName);
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            if (this.disposed || this.browser != targetBrowser) {
                return;
            }
            try {
                org.cef.browser.CefBrowser cefBrowser = targetBrowser.getCefBrowser();
                String callee = functionName;
                if (!functionName.contains(".")) {
                    callee = "window." + functionName;
                }

                StringBuilder argsJs = new StringBuilder();
                if (args != null) {
                    for (int i = 0; i < args.length; i++) {
                        if (i > 0) { argsJs.append(", "); }
                        String arg = args[i] == null ? "" : args[i];
                        argsJs.append("'").append(arg).append("'");
                    }
                }

                String checkAndCall =
                        "(function() {" +
                                "  try {" +
                                "    if (typeof " + callee + " === 'function') {" +
                                "      " + callee + "(" + argsJs + ");" +
                                "    }" +
                                "  } catch (e) {" +
                                "    console.error('[Backend->Frontend] Failed to call " + functionName + ":', e);" +
                                "  }" +
                                "})();";

                cefBrowser.executeJavaScript(checkAndCall, cefBrowser.getURL(), 0);
            } catch (Exception | LinkageError e) {
                LOG.warn("Failed to call JS function: " + functionName + ", error: " + e.getMessage(), e);
            }
        });
    }

    void handleJavaScriptMessage(String message) {
        if (message == null) {
            return;
        }
        // Serialized against dispose() via the dispatch gate. dispose's beginTeardown() waits for
        // any in-flight dispatch to finish and blocks new ones, so no handler side effect (e.g.
        // SessionHandler scheduling an async session.send) can start after teardown has begun. The
        // gate monitor is held only across dispatch - dispose runs its heavy teardown (browser
        // disposal, process cleanup) outside it, so the JCEF thread never waits on the EDT. That
        // keeps the old dispatch/dispose lifecycle exclusion without the EDT<->JCEF deadlock.
        this.dispatchGate.runInDispatch(() -> this.handleJavaScriptMessageLocked(message));
    }

    /**
     * Dispatch body, run under the {@link MessageDispatchGate} so it is serialized against
     * {@code dispose()}. The gate guarantees the window is not disposed for the whole call, so no
     * per-handler disposed re-check is needed here.
     */
    private void handleJavaScriptMessageLocked(String message) {
        if (message.startsWith("{\"type\":\"console.")) {
            try {
                JsonObject json = new Gson().fromJson(message, JsonObject.class);
                String logType = json.get("type").getAsString();
                JsonArray args = json.getAsJsonArray("args");

                StringBuilder logMessage = new StringBuilder("[Webview] ");
                for (int i = 0; i < args.size(); i++) {
                    if (i > 0) { logMessage.append(" "); }
                    logMessage.append(args.get(i).toString());
                }

                if ("console.error".equals(logType)) {
                    LOG.warn(logMessage.toString());
                } else if ("console.warn".equals(logType)) {
                    LOG.info(logMessage.toString());
                } else {
                    LOG.debug(logMessage.toString());
                }
            } catch (Exception e) {
                LOG.warn("Failed to parse console log: " + e.getMessage());
            }
            return;
        }

        String[] parts = message.split(":", 2);
        if (parts.length < 1) {
            LOG.error("Invalid message format");
            return;
        }

        String type = parts[0];
        String content = parts.length > 1 ? parts[1] : "";

        MessageDispatcher dispatcher = this.messageDispatcher;
        if (dispatcher == null) {
            return;
        }
        if (dispatcher.dispatch(type, content)) {
            return;
        }

        LOG.warn("Unknown message type: " + type);
    }

    // ==================== Session Delegates ====================

    private void setupSessionCallbacks() {
        // Re-sync the exposed sessionId with the freshly bound session so a stale
        // AI session ID from a previous session is not exposed via getSessionId().
        // Falling back to permissionServiceKey (never null after construction)
        // keeps the exposed ID stable for consumers like DetachTabAction, which
        // skips DetachedWindowManager registration on a null ID.
        this.sessionId = resolveExposedSessionId(session.getSessionId(), this.permissionServiceKey);

        if (this.sessionCallbackAdapter != null) {
            this.sessionCallbackAdapter.deactivate();
        }
        this.sessionCallbackAdapter = new SessionCallbackAdapter(
                streamCoalescer,
                new SessionCallbackAdapter.JsTarget() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                        ClaudeChatWindow.this.callJavaScript(functionName, args);
                    }
                },
                permissionHandler,
                () -> slashCommandsFetched,
                this::onStreamEnded
        ) {
            @Override
            public void onSessionIdReceived(String newSessionId) {
                super.onSessionIdReceived(newSessionId);
                sessionId = newSessionId;
                persistTabSessionState();
            }

            @Override
            public void onStateChange(boolean busy, boolean loading, String error) {
                super.onStateChange(busy, loading, error);
                // Deliberately outside super's active-check: a deactivated adapter
                // stops talking to the webview, but a hold it took must still be
                // released. Both providers route every busy transition through here.
                updateBusyKeepAwake(busy);
            }

            @Override
            public void onTurnError(String error) {
                super.onTurnError(error);
                // The busy hold has just been dropped by onStateChange, but this may
                // be a usage-limit failure that ends in a scheduled restart — in
                // which case sleep must stay blocked. Hold across the assessment so
                // the decision, not a race with it, decides whether we let go.
                KeepAwakeService.getInstance().acquire(limitCheckKeepAwakeToken, "usage-limit assessment");
                autoResumeController.onTurnError(error).whenComplete((ignored, throwable) ->
                        KeepAwakeService.getInstance().release(limitCheckKeepAwakeToken));
            }
        };
        session.setCallback(sessionCallbackAdapter);

        // Wire daemon events directly to frontend (bypasses adapter lifecycle).
        // Calling through sessionCallbackAdapter would silently drop the event
        // if setupSessionCallbacks() is invoked again before the title arrives
        // (adapter.deactivate() → isInactive() → event discarded).
        // Register only once per ClaudeChatWindow; subsequent setupSessionCallbacks()
        // calls reuse the existing listener so the bridge keeps a single registration
        // per window. The listener is removed in dispose().
        if (this.titleEventListener == null) {
            this.titleEventListener = (event, data) -> {
                if ("title_generated".equals(event)) {
                    String genSessionId = data.has("sessionId") ? data.get("sessionId").getAsString() : null;
                    String title = data.has("title") ? data.get("title").getAsString() : null;
                    if (genSessionId != null && title != null) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            if (!disposed) {
                                callJavaScript("updateSessionTitle",
                                        JsUtils.escapeJs(genSessionId), JsUtils.escapeJs(title));
                            }
                        });
                    }
                } else if ("session_updated".equals(event)) {
                    // Handle inter-turn session updates (background task completion)
                    String updatedSessionId = data.has("sessionId") ? data.get("sessionId").getAsString() : null;
                    if (updatedSessionId == null) {
                        LOG.warn("[ClaudeChatWindow] session_updated event missing sessionId");
                        return;
                    }

                    // Compare with current active session
                    String currentSessionId = session != null ? session.getSessionId() : null;
                    if (currentSessionId == null || !currentSessionId.equals(updatedSessionId)) {
                        // Event is for a session this window no longer holds (the user
                        // navigated away, or a resume forked the id). Log it — this branch
                        // is otherwise silent and a divergence here would strand a
                        // background-task refresh.
                        LOG.info("[ClaudeChatWindow] session_updated ignored: updatedSessionId="
                                + updatedSessionId + " != currentSessionId=" + currentSessionId);
                        return;
                    }

                    // If a turn is streaming, DON'T reload now (clearMessages() off
                    // the EDT would race the streaming append and disturb the live
                    // bubble). DON'T drop it either, or a background-turn answer would
                    // stay invisible until the user reopens the session. Park the id
                    // and drain it at stream end (onStreamEnded).
                    if (sessionCallbackAdapter != null && streamCoalescer != null && streamCoalescer.isStreamActive()) {
                        deferredReload.defer(updatedSessionId);
                        // onStreamEnded drains this at the next stream-end. Also arm the
                        // safety backstop so a defer that races the stream-end edge — or
                        // the last fan-out answer with no following stream end — is still
                        // drained once the stream goes idle (see deferredReloadSafetyTick).
                        scheduleDeferredReloadSafetyDrain();
                        LOG.info("[ClaudeChatWindow] session_updated during active turn, deferring reload to stream end");
                        return;
                    }

                    LOG.info("[ClaudeChatWindow] session_updated for sessionId=" + updatedSessionId + ", reloading from server");

                    // Reuse the canonical reload path (same as history-load / rewind):
                    // loadFromServer() reads the session via the bridge, converts each
                    // record with MessageParser.parseServerMessage(), and pushes a full
                    // refresh through the callback facade. Coalesced so overlapping
                    // background-task completions never reload concurrently.
                    //
                    // Pass updatedSessionId as the reload target: the session field can
                    // be reassigned on the EDT (new-session / restart flows) between the
                    // currentSessionId check above and the reload actually running.
                    // driveSessionReload() re-validates the id at entry and after
                    // loadFromServer() returns, so a reload never lands on a session
                    // that the user has navigated away from.
                    requestSessionReload(updatedSessionId);
                } else if ("inter_turn_activity".equals(event)) {
                    // A background-task continuation started/ended between turns. Show
                    // the agent as "working" so the wake-up is visible; the paired
                    // session_updated events stream in the actual messages. We drive the
                    // thinking indicator (not loading), because loading is toggled by the
                    // per-message reloads (onStateChange → showLoading) and would flicker.
                    String activitySessionId = data.has("sessionId") ? data.get("sessionId").getAsString() : null;
                    boolean active = data.has("active") && data.get("active").getAsBoolean();
                    if (activitySessionId == null) {
                        return;
                    }
                    String currentSessionId = session != null ? session.getSessionId() : null;
                    if (currentSessionId == null || !currentSessionId.equals(activitySessionId)) {
                        return;
                    }
                    // A live user turn drives its own indicators — don't interfere.
                    if (streamCoalescer != null && streamCoalescer.isStreamActive()) {
                        return;
                    }
                    LOG.info("[ClaudeChatWindow] inter_turn_activity active=" + active
                            + " for sessionId=" + activitySessionId);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (!disposed) {
                            callJavaScript("showThinkingStatus", active ? "true" : "false");
                        }
                    });
                } else if ("task_event".equals(event)) {
                    // Async subagent (Agent/Task tool with run_in_background:true)
                    // lifecycle event forwarded by the
                    // ai-bridge perpetual reader. task_notification arrives inter-turn
                    // (after the turn's result), so it cannot ride the normal [MESSAGE]
                    // stream -- route it to the frontend via onTaskEvent so the subagent
                    // list reflects completion/usage instead of staying on "running".
                    String taskSessionId = data.has("sessionId") && data.get("sessionId").isJsonPrimitive()
                            ? data.get("sessionId").getAsString() : null;
                    if (taskSessionId == null) {
                        LOG.warn("[ClaudeChatWindow] task_event event missing sessionId");
                        return;
                    }
                    // Mirror session_updated's guard: drop events that do not match the
                    // active session so a stale background-agent completion cannot leak
                    // into a session the user has since navigated to. Capture the
                    // adapter into a local before the session check: session and
                    // sessionCallbackAdapter are both volatile and reassigned on the EDT,
                    // so reading them separately could route an old-session event to a
                    // newly activated adapter. The captured adapter's onTaskEvent
                    // re-checks isInactive(), so if the session switched after the
                    // snapshot the delivery is skipped.
                    var adapter = sessionCallbackAdapter;
                    String currentSessionId = session != null ? session.getSessionId() : null;
                    if (currentSessionId == null || !currentSessionId.equals(taskSessionId)) {
                        return;
                    }
                    if (adapter != null && data.has("taskEvent") && !data.get("taskEvent").isJsonNull()) {
                        adapter.onTaskEvent(data.get("taskEvent").toString());
                    }
                }
            };
            this.claudeSDKBridge.addDaemonEventListener(this.titleEventListener);
        }

        persistTabSessionState();
    }

    /**
     * Request a reload of the current session from the server, coalescing
     * concurrent requests. Multiple session_updated events (e.g. several
     * background tasks finishing at once) must not run loadFromServer()
     * concurrently — SessionState's message list is not thread-safe and the
     * reload runs on a background thread. At most one reload is in flight;
     * requests arriving during a reload collapse into a single follow-up reload
     * that reflects the latest JSONL.
     *
     * @param targetSessionId the session id this reload is bound to. Carried
     *     through the whole coalesced chain and re-validated at every step so a
     *     reload never runs against a session the user has navigated away from
     *     (the session field is reassigned on the EDT by new-session / restart).
     */
    private void requestSessionReload(String targetSessionId) {
        synchronized (sessionReloadLock) {
            if (sessionReloadInFlight) {
                sessionReloadPending = true;
                return;
            }
            sessionReloadInFlight = true;
        }
        driveSessionReload(targetSessionId);
    }

    /**
     * Run a session_updated reload that was deferred because a turn was
     * streaming (see the session_updated handler). Called from the coalescer's
     * onStreamEnded hook when the stream goes inactive — the safe point to
     * reload, since SessionState is no longer being mutated by a streaming turn.
     * A no-op when nothing was deferred. The reload still validates the target
     * session before touching anything (driveSessionReload), so a session the
     * user has navigated away from is never reloaded.
     */
    private void drainDeferredReload() {
        String target = deferredReload.takeIfRunnable(disposed);
        if (target == null) {
            return;
        }
        LOG.info("[ClaudeChatWindow] draining deferred session_updated reload after stream end, sessionId=" + target);
        requestSessionReload(target);
    }

    /**
     * What the safety backstop should do on a tick. Pure function so the
     * park/stream/dispose state machine is unit-testable without a full
     * ClaudeChatWindow.
     *
     * <ul>
     *   <li>{@code DONE} — disposed, or nothing parked (the fast onStreamEnded
     *       path already drained it): stop polling.</li>
     *   <li>{@code RECHECK_LATER} — still parked but a stream is active:
     *       reloading now would race the streaming append, so wait and re-check.</li>
     *   <li>{@code DRAIN} — parked and the stream is idle: the safe point to
     *       drain, even though no onStreamEnded edge arrived for this defer.</li>
     * </ul>
     */
    enum SafetyDrainAction { DONE, RECHECK_LATER, DRAIN }

    static SafetyDrainAction decideDeferredReloadSafety(boolean disposed, boolean hasPending, boolean streamActive) {
        if (disposed || !hasPending) {
            return SafetyDrainAction.DONE;
        }
        return streamActive ? SafetyDrainAction.RECHECK_LATER : SafetyDrainAction.DRAIN;
    }

    /** (Re)arm the safety backstop; overlapping arms collapse to one pending tick. */
    private void scheduleDeferredReloadSafetyDrain() {
        if (disposed) {
            return;
        }
        deferredReloadSafetyAlarm.cancelAllRequests();
        deferredReloadSafetyAlarm.addRequest(this::deferredReloadSafetyTick, DEFERRED_RELOAD_SAFETY_DRAIN_MS);
    }

    /**
     * Backstop tick: drain a still-parked reload once the stream is idle, or
     * re-check later while it is still streaming. Guarantees the last background
     * answer of a fan-out is never orphaned by a missed/raced onStreamEnded edge.
     * A no-op when the fast path already drained the parked reload.
     */
    private void deferredReloadSafetyTick() {
        boolean streamActive = streamCoalescer != null && streamCoalescer.isStreamActive();
        switch (decideDeferredReloadSafety(disposed, deferredReload.hasPending(), streamActive)) {
            case DRAIN:
                LOG.info("[ClaudeChatWindow] safety-draining deferred reload (no stream-end edge followed the defer)");
                drainDeferredReload();
                break;
            case RECHECK_LATER:
                scheduleDeferredReloadSafetyDrain();
                break;
            case DONE:
            default:
                break;
        }
    }

    /**
     * Coordinates a session_updated reload that arrived while a turn was
     * streaming. Reloading mid-stream is unsafe: {@code loadFromServer()} runs
     * {@code clearMessages()} on SessionState off the EDT, which would race the
     * streaming append and disturb the live streaming bubble. So the target
     * session id is parked here and drained at stream end (onStreamEnded),
     * making background-turn answers appear at the next turn boundary instead of
     * only after the user reopens the session.
     *
     * <p>Thread-safety: {@code defer} is called from the daemon event thread,
     * {@code takeIfRunnable} from the coalescer's onStreamEnded hook; both are
     * fully synchronized so a defer/drain interleave never loses or duplicates a
     * pending reload. {@code take} atomically reads-clears-and-gates in one
     * critical section (no read/clear window). Coalescing is last-writer-wins:
     * overlapping background completions collapse into a single reload, which is
     * correct because a reload always reflects the latest JSONL. Extracted as a
     * static nested class so the coordination is unit-testable without a full
     * ClaudeChatWindow (which needs a Project, JBCefBrowser, etc.).
     */
    static final class DeferredReload {
        private String pendingSessionId;

        /** Park a reload for {@code sessionId} (last writer wins). */
        synchronized void defer(String sessionId) {
            this.pendingSessionId = sessionId;
        }

        /**
         * Atomically take-and-clear the parked reload, returning its target only
         * when it should actually run: something was deferred AND the window is
         * still alive. Returns {@code null} otherwise (and still clears, so a
         * stale parked id from a disposed window is not left behind). The target
         * is re-validated against the active session later in
         * driveSessionReload(), so this only gates the coarse "is there anything
         * to drain" question.
         */
        synchronized String takeIfRunnable(boolean disposed) {
            String target = pendingSessionId;
            pendingSessionId = null;
            return (target != null && !disposed) ? target : null;
        }

        /** Visible for testing: whether a reload is currently parked. */
        synchronized boolean hasPending() {
            return pendingSessionId != null;
        }
    }

    private void driveSessionReload(String targetSessionId) {
        // Re-validate at entry: the session may have been replaced on the EDT
        // between the listener's sessionId check and this call.
        if (disposed || !isSessionActive(targetSessionId)) {
            synchronized (sessionReloadLock) {
                sessionReloadInFlight = false;
                sessionReloadPending = false;
            }
            return;
        }
        // A narrow window remains: the EDT can reassign `session` between the
        // isSessionActive() check above and the `current = session` read below,
        // so `current` may be a session the user has navigated away from. This is
        // safe by design: loadFromServer() pushes its result through `current`'s
        // own callbackFacade → SessionCallbackAdapter, and that adapter is
        // deactivated by setupSessionCallbacks() when the new session is bound
        // (volatile `active` flag, checked in every on* callback). So a stale
        // reload's onMessageUpdate/onStateChange are silently dropped, and the
        // isSessionActive() check in the continuation additionally blocks any
        // follow-up reload. Two independent guards; neither alone is sufficient.
        ClaudeSession current = session;
        current.loadFromServer().whenComplete((v, ex) -> {
            if (ex != null) {
                LOG.warn("[ClaudeChatWindow] session reload failed", ex);
            }
            boolean runAgain;
            synchronized (sessionReloadLock) {
                runAgain = decideReloadCompletion(
                        sessionReloadPending, disposed, isSessionActive(targetSessionId));
                // Always clear sessionReloadPending: on the runAgain path the
                // pending request is consumed; on the finish path any stale flag
                // (possibly bound to a session the user navigated away from) must
                // be dropped so the next same-session reload does not inherit it.
                sessionReloadPending = false;
                if (!runAgain) {
                    sessionReloadInFlight = false;
                }
            }
            if (runAgain) {
                driveSessionReload(targetSessionId);
            }
        });
    }

    /**
     * Pure decision function for what to do when an in-flight
     * {@code loadFromServer()} reload completes. Extracted so the coalescing
     * state machine is unit-testable without constructing a full
     * ClaudeChatWindow (which needs a Project, JBCefBrowser, etc.).
     *
     * <p>Returns {@code true} (run another reload) only when ALL of:
     * <ul>
     *   <li>a follow-up is pending ({@code sessionReloadPending}), AND</li>
     *   <li>the window is still alive ({@code !disposed}), AND</li>
     *   <li>the session the reload was started for is still active
     *       ({@code sessionMatches}). If the user navigated to a different
     *       session, the pending flag belongs to the old session and must not
     *       trigger a reload against the new one — the new session drives its
     *       own lifecycle.</li>
     * </ul>
     *
     * <p>Either way the caller clears {@code sessionReloadPending}; this
     * function only decides whether to re-run.
     *
     * @param pending        current value of {@code sessionReloadPending}
     * @param disposed       whether the window has been disposed
     * @param sessionMatches whether {@code session} still identifies the
     *                       session this reload was bound to
     * @return {@code true} to collapse the pending request into another reload;
     *         {@code false} to finish (the in-flight flag is cleared by the
     *         caller)
     */
    static boolean decideReloadCompletion(
            boolean pending, boolean disposed, boolean sessionMatches) {
        return pending && !disposed && sessionMatches;
    }

    /**
     * Returns true iff the window currently holds the session identified by
     * {@code sessionId} (i.e. it has not been replaced by a new-session /
     * restart flow on the EDT). The session field is volatile, so this read is
     * safe from the daemon-reader and loadFromServer() continuation threads.
     */
    private boolean isSessionActive(String sessionId) {
        ClaudeSession current = session;
        if (current == null || sessionId == null) {
            return false;
        }
        String currentId = current.getSessionId();
        return sessionId.equals(currentId);
    }

    private void onStreamEnded() {
        if (session == null) {
            return;
        }
        if ("claude".equals(session.getProvider()) && session.getError() == null) {
            com.github.ccxgui.notifications.ClaudeNotifier.showSuccess(
                project,
                com.github.ccxgui.notifications.ClaudeNotifier.buildTitleFromSession(session),
                com.github.ccxgui.notifications.ClaudeNotifier.buildPreviewFromSession(session, "Task completed"));
        }
    }

    private void initializeSessionInfo() {
        String workingDirectory = sessionLifecycleManager.determineWorkingDirectory();
        session.setSessionInfo(null, workingDirectory);
        persistTabSessionState();
        LOG.info("Initialized with working directory: " + workingDirectory);
    }

    private void registerInstance() {
        ClaudeSDKToolWindow.registerWindow(project, this);
    }

    private void interruptDueToPermissionDenial() {
        this.session.interrupt().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onPermissionDenied");
            callJavaScript("onStreamEnd");
            callJavaScript("showLoading", "false");
            com.github.ccxgui.notifications.ClaudeNotifier.clearStatus(project);
        }));
    }

    private int getTabIndex() {
        Content content = this.parentContent;
        if (content == null) {
            return -1;
        }
        ContentManager contentManager = content.getManager();
        if (contentManager == null) {
            return -1;
        }
        return contentManager.getIndexOfContent(content);
    }

    private void persistTabSessionState() {
        if (project == null || project.isDisposed() || session == null) {
            return;
        }

        int tabIndex = getTabIndex();
        if (tabIndex < 0) {
            return;
        }

        TabStateService.TabSessionState snapshot = new TabStateService.TabSessionState();
        // Persist provider/model only once this tab actually has them chosen.
        // Writing the placeholder defaults would make the next IDE start restore
        // them as a real per-tab preference, which then outranks (and discards)
        // the selection the webview remembered.
        snapshot.provider = session.isProviderExplicitlySet() ? session.getProvider() : null;
        snapshot.sessionId = session.getSessionId();
        snapshot.cwd = session.getCwd();
        snapshot.model = session.isModelExplicitlySet() ? session.getModel() : null;
        snapshot.permissionMode = session.getPermissionMode();
        snapshot.reasoningEffort = session.getReasoningEffort();
        snapshot.claudeAutoResumeWakeAt = autoResumeController != null ? autoResumeController.getWakeAtMs() : 0L;
        snapshot.scheduledSendAt = scheduledSendController != null ? scheduledSendController.getFireAtMs() : 0L;
        snapshot.scheduledSendText = scheduledSendController != null ? scheduledSendController.getMessage() : null;

        TabStateService.getInstance(project).saveTabSessionState(tabIndex, snapshot);
    }

    /**
     * Build the {@link ClaudeAutoResumeController.Host} bridging the controller to
     * this window: live session access, disposal state, wake persistence, and the
     * webview status push. Persistence rides {@link #persistTabSessionState()},
     * which reads the controller's current wake time — so an arm/disarm here
     * automatically saves (or clears) the persisted wake.
     */
    private ClaudeAutoResumeController.Host createAutoResumeHost() {
        return new ClaudeAutoResumeController.Host() {
            @Override
            public String provider() {
                ClaudeSession current = session;
                return current != null ? current.getProvider() : null;
            }

            @Override
            public boolean isActive() {
                return !disposed;
            }

            @Override
            public void onArmed(long wakeAtMs, java.util.Set<String> exhaustedWindows) {
                persistTabSessionState();
                // A restart is scheduled, so the work is not finished — keep the
                // machine awake through the wait. This is also what makes the wake
                // fire on time: a scheduled wake does not survive the machine
                // sleeping through its deadline.
                KeepAwakeService.getInstance().acquire(autoResumeKeepAwakeToken, "auto-resume armed");
                pushAutoResumeStatus(true, wakeAtMs, exhaustedWindows, false);
            }

            @Override
            public void resume(String prompt) {
                ClaudeSession current = session;
                if (current == null) {
                    return;
                }
                // Cast disambiguates send(String, String agentPrompt) from the
                // send(String, List<Attachment>) overload; null = default agent.
                current.send(prompt, (String) null).exceptionally(ex -> {
                    LOG.warn("[ClaudeAutoResume] Resume send failed: " + ex.getMessage());
                    return null;
                });
            }

            @Override
            public void onManualResumeNeeded(long wakeAtMs) {
                persistTabSessionState();
                // Auto-resume gave up; the next move is a human's, so there is
                // nothing left worth keeping the machine awake for.
                KeepAwakeService.getInstance().release(autoResumeKeepAwakeToken);
                pushAutoResumeStatus(false, wakeAtMs, java.util.Collections.emptySet(), true);
            }

            @Override
            public void onDisarmed() {
                persistTabSessionState();
                // Fires immediately before the resume prompt is sent, so the busy
                // hold that send takes replaces this one; the service's release
                // grace covers the gap between the two.
                KeepAwakeService.getInstance().release(autoResumeKeepAwakeToken);
                pushAutoResumeStatus(false, 0L, java.util.Collections.emptySet(), false);
            }
        };
    }

    /**
     * Build the {@link ScheduledSendController.Host} bridging the controller to
     * this window. Mirrors {@link #createAutoResumeHost()}: persistence rides
     * {@link #persistTabSessionState()}, which reads the controller's current
     * schedule, so arming and disarming save (or clear) it automatically.
     */
    private ScheduledSendController.Host createScheduledSendHost() {
        return new ScheduledSendController.Host() {
            @Override
            public boolean isActive() {
                return !disposed;
            }

            @Override
            public boolean isBusy() {
                ClaudeSession current = session;
                return current != null && current.isBusy();
            }

            @Override
            public void onArmed(long fireAtMs, String message) {
                missedScheduledSendText = null;
                persistTabSessionState();
                // A scheduled wake does not survive the machine idle-sleeping
                // through its deadline, so hold the machine awake until it fires.
                KeepAwakeService.getInstance().acquire(scheduledSendKeepAwakeToken, "scheduled send pending");
                pushScheduledSendStatus(true, fireAtMs, message, false, null);
            }

            @Override
            public void send(String message) {
                ClaudeSession current = session;
                if (current == null) {
                    return;
                }
                // Cast disambiguates send(String, String agentPrompt) from the
                // send(String, List<Attachment>) overload; null = default agent.
                current.send(message, (String) null).exceptionally(ex -> {
                    LOG.warn("[ScheduledSend] Send failed: " + ex.getMessage());
                    return null;
                });
            }

            @Override
            public void onMissed(long fireAtMs, String message) {
                // Held so the "Send now" button has something to send: the
                // controller has already dropped its own copy by this point.
                missedScheduledSendText = message;
                persistTabSessionState();
                // The next move is a human's; nothing left worth staying awake for.
                KeepAwakeService.getInstance().release(scheduledSendKeepAwakeToken);
                pushScheduledSendStatus(false, fireAtMs, message, true, null);
            }

            @Override
            public void onDisarmed() {
                missedScheduledSendText = null;
                persistTabSessionState();
                // Fires immediately before the message is sent, so the busy hold
                // that send takes replaces this one; the service's release grace
                // covers the gap between the two.
                KeepAwakeService.getInstance().release(scheduledSendKeepAwakeToken);
                pushScheduledSendStatus(false, 0L, null, false, null);
            }
        };
    }

    /**
     * Push the current scheduled-send state to the webview. {@code errorCode} is
     * non-null only when a schedule request was rejected, in which case the rest of
     * the payload still describes the (unchanged) current state. The frontend
     * consumes {@code window.updateScheduledSendStatus}; the call is a safe no-op
     * until that handler exists.
     */
    private void pushScheduledSendStatus(boolean scheduled, long fireAtMs, String message,
                                         boolean missed, String errorCode) {
        JsonObject payload = new JsonObject();
        payload.addProperty("scheduled", scheduled);
        payload.addProperty("fireAt", fireAtMs);
        payload.addProperty("missed", missed);
        // Only a preview travels: the banner shows one line, and the full text can
        // run to ScheduledSendController.MAX_MESSAGE_LENGTH. "Send now" reads the
        // authoritative copy on this side, so the webview never needs all of it.
        payload.addProperty("preview", buildSchedulePreview(message));
        if (errorCode != null) {
            payload.addProperty("error", errorCode);
        }
        callJavaScript("updateScheduledSendStatus", JsUtils.escapeJs(new Gson().toJson(payload)));
    }

    private static final int SCHEDULE_PREVIEW_LENGTH = 120;

    private static String buildSchedulePreview(String message) {
        if (message == null) {
            return "";
        }
        String flattened = message.replaceAll("\\s+", " ").trim();
        return flattened.length() > SCHEDULE_PREVIEW_LENGTH
                ? flattened.substring(0, SCHEDULE_PREVIEW_LENGTH) + "…"
                : flattened;
    }

    /** Re-push the current scheduled-send state, e.g. after the webview reloaded. */
    private void pushCurrentScheduledSendStatus() {
        if (scheduledSendController == null) {
            return;
        }
        if (scheduledSendController.isArmed()) {
            pushScheduledSendStatus(true, scheduledSendController.getFireAtMs(),
                    scheduledSendController.getMessage(), false, null);
        } else if (missedScheduledSendText != null) {
            pushScheduledSendStatus(false, 0L, missedScheduledSendText, true, null);
        } else {
            pushScheduledSendStatus(false, 0L, null, false, null);
        }
    }

    /**
     * Map a rejected schedule request to the frontend's error vocabulary. Returns
     * {@code null} for a successful request.
     */
    private static String scheduleErrorCode(ScheduledSendController.Result result) {
        switch (result) {
            case EMPTY_MESSAGE:
                return "empty";
            case MESSAGE_TOO_LONG:
                return "tooLong";
            case TIME_IN_PAST:
                return "past";
            case TOO_FAR_AHEAD:
                return "tooFarAhead";
            default:
                return null;
        }
    }

    /**
     * Mirror the session's busy flag into the application-wide keep-awake state.
     * Idempotent by design: {@link KeepAwakeService} keys holds by token identity,
     * so the repeated {@code busy=false} reports the message handlers emit collapse
     * into a single release.
     */
    private void updateBusyKeepAwake(boolean busy) {
        KeepAwakeService service = KeepAwakeService.getInstance();
        if (busy) {
            service.acquire(busyKeepAwakeToken, "agent busy");
        } else {
            service.release(busyKeepAwakeToken);
        }
    }

    /**
     * Push the current auto-resume state to the webview as a JSON payload. The
     * frontend banner consumes {@code window.updateClaudeAutoResumeStatus}; the
     * call is a safe no-op until that handler exists.
     */
    private void pushAutoResumeStatus(boolean armed, long wakeAtMs,
                                      java.util.Set<String> windows, boolean manualResumeNeeded) {
        JsonObject payload = new JsonObject();
        payload.addProperty("armed", armed);
        payload.addProperty("wakeAt", wakeAtMs);
        payload.addProperty("manualResumeNeeded", manualResumeNeeded);
        JsonArray windowsJson = new JsonArray();
        if (windows != null) {
            for (String w : windows) {
                windowsJson.add(w);
            }
        }
        payload.add("windows", windowsJson);
        callJavaScript("updateClaudeAutoResumeStatus", JsUtils.escapeJs(new Gson().toJson(payload)));
    }

    private boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }

    /**
     * Decide what {@link #getSessionId()} exposes after session callbacks are
     * (re-)bound: the bound session's own ID when it has one (history load),
     * otherwise the stable permission-service key (fresh session) — never a
     * stale ID left over from a previously bound session.
     */
    static String resolveExposedSessionId(String boundSessionId, String permissionServiceKey) {
        return boundSessionId != null && !boundSessionId.trim().isEmpty()
                ? boundSessionId
                : permissionServiceKey;
    }

    // ==================== Code Snippets ====================

    private void addCodeSnippet(String selectionInfo) {
        if (selectionInfo != null && !selectionInfo.isEmpty()) {
            // Ensure the browser has focus so the frontend can focus the input field
            if (browser != null) {
                browser.getComponent().requestFocus();
            }
            callJavaScript("addCodeSnippet", JsUtils.escapeJs(selectionInfo));
        }
    }

    /**
     * Focus the chat input field in the frontend.
     * Called when Ctrl+Alt+K activates the panel without a selection.
     */
    public void focusInputPane() {
        JBCefBrowser targetBrowser = this.browser;
        if (this.disposed || targetBrowser == null) {
            return;
        }
        try {
            if (this.browser != targetBrowser) {
                return;
            }
            targetBrowser.getComponent().requestFocus();
        } catch (Exception | LinkageError e) {
            LOG.debug("Skip focus input pane: webview is unavailable", e);
            return;
        }
        executeJavaScriptCode("window.focusChatInput?.()");
    }

    // ==================== Dispose ====================

    public void dispose() {
        // Begin teardown under the dispatch gate: this waits for any in-flight dispatch to finish
        // (so no handler side effect - e.g. an async session.send - can start after this point) and
        // blocks new dispatch from entering. The gate monitor is released before the heavy teardown
        // below, so the JCEF thread never waits on the EDT - that was the original EDT<->JCEF
        // deadlock. beginTeardown() is idempotent; a repeat dispose returns immediately.
        if (!this.dispatchGate.beginTeardown()) {
            return;
        }
        this.disposed = true;

        // First, ahead of any teardown step that could throw: closing a tab mid-turn
        // (or with a wake armed) must not strand a keep-awake hold, because nothing
        // is left afterwards to release it and the machine would never sleep again.
        // Safe to repeat — releasing a token that is not held is a no-op.
        KeepAwakeService keepAwakeService = KeepAwakeService.getInstance();
        keepAwakeService.release(busyKeepAwakeToken);
        keepAwakeService.release(limitCheckKeepAwakeToken);
        keepAwakeService.release(autoResumeKeepAwakeToken);
        keepAwakeService.release(scheduledSendKeepAwakeToken);

        JBCefBrowser targetBrowser = this.browser;
        this.browser = null;
        if (this.handlerContext != null) {
            this.handlerContext.setDisposed(true);
            this.handlerContext.setBrowser(null);
        }
        webviewWatchdog.stop();

        try {
            if (this.webviewInitializer != null) {
                this.webviewInitializer.disposeBridges();
            }
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to dispose webview bridges: " + e.getMessage(), e);
        }

        chatWindowDelegate.dispose();
        editorContextTracker.dispose();
        streamCoalescer.dispose();
        if (autoResumeController != null) {
            // Stops the scheduled wake only; persisted state is left intact so a
            // wake survives IDE shutdown (tab close removes the tab state itself).
            autoResumeController.dispose();
        }
        if (scheduledSendController != null) {
            // Same contract as above: cancels the pending fire, leaves the
            // persisted schedule for restoreFromPersisted to replay.
            scheduledSendController.dispose();
        }
        deferredReloadSafetyAlarm.cancelAllRequests();
        Disposer.dispose(safetyAlarmDisposable);
        if (sessionCallbackAdapter != null) {
            sessionCallbackAdapter.dispose();
        }
        if (titleEventListener != null && claudeSDKBridge != null) {
            try {
                claudeSDKBridge.removeDaemonEventListener(titleEventListener);
            } catch (Exception e) {
                LOG.warn("Failed to remove daemon event listener: " + e.getMessage());
            }
            titleEventListener = null;
        }

        try {
            if (this.permissionServiceKey != null && !this.permissionServiceKey.isEmpty()) {
                PermissionService permissionService = PermissionService.getInstance(project, this.permissionServiceKey);
                permissionService.unregisterDialogShower(project);
                permissionService.unregisterAskUserQuestionDialogShower(project);
                permissionService.unregisterPlanApprovalDialogShower(project);
                PermissionService.removeInstance(this.permissionServiceKey);
                LOG.info("Removed PermissionService instance for key: " + this.permissionServiceKey);
            }
        } catch (Exception e) {
            LOG.warn("Failed to unregister dialog showers or remove session instance: " + e.getMessage());
        }

        LOG.info("Starting window resource cleanup, project: " + project.getName());

        if (parentContent != null) {
            ClaudeSDKToolWindow.unregisterContentMapping(parentContent);
            LOG.debug("[MultiTab] Removed Content -> ClaudeChatWindow mapping during dispose");
        }

        ClaudeSDKToolWindow.unregisterWindow(project, this);

        try {
            if (session != null) { session.interrupt(); }
        } catch (Exception e) {
            LOG.warn("Failed to clean up session: " + e.getMessage());
        }

        try {
            if (claudeSDKBridge != null) {
                int activeCount = claudeSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("Cleaning up " + activeCount + " active Claude process(es)...");
                }
                claudeSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("Failed to clean up Claude processes: " + e.getMessage());
        }

        try {
            if (codexSDKBridge != null) {
                int activeCount = codexSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("Cleaning up " + activeCount + " active Codex process(es)...");
                }
                codexSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("Failed to clean up Codex processes: " + e.getMessage());
        }

        try {
            if (targetBrowser != null) {
                targetBrowser.dispose();
            }
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to clean up browser: " + e.getMessage(), e);
        }

        if (messageDispatcher != null) {
            messageDispatcher.clear();
        }

        LOG.info("Window resources fully cleaned up, project: " + project.getName());
    }

    // ==================== Host Interface Factories ====================

    private WebviewInitializer.WebviewHost createWebviewHost() {
        return new WebviewInitializer.WebviewHost() {
            @Override
            public Project getProject() {
                return project;
            }

            @Override
            public ClaudeSDKBridge getClaudeSDKBridge() {
                return claudeSDKBridge;
            }

            @Override
            public CodexSDKBridge getCodexSDKBridge() {
                return codexSDKBridge;
            }

            @Override
            public JPanel getMainPanel() {
                return mainPanel;
            }

            @Override
            public HtmlLoader getHtmlLoader() {
                return htmlLoader;
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public void setBrowser(JBCefBrowser b) {
                browser = b;
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public void handleJavaScriptMessage(String msg) {
                ClaudeChatWindow.this.handleJavaScriptMessage(msg);
            }

            @Override
            public WebviewWatchdog getWebviewWatchdog() {
                return webviewWatchdog;
            }

            @Override
            public boolean isFrontendReady() {
                return frontendReady;
            }

            @Override
            public void setFrontendReady(boolean ready) {
                updateFrontendReadyState(ready);
            }
        };
    }

    /**
     * Soft-reload the active session's transcript from the server without
     * interrupting any in-flight turn.
     * <p>Used when the user re-opens the session that is already active: instead
     * of tearing it down (interrupt + recreate), we merely refresh the transcript
     * so the latest on-disk state is reflected. Reuses the {@code session_updated}
     * reload path (coalescing + isSessionActive guard), and defers to stream end
     * when a turn is live so the streaming bubble is never disturbed.</p>
     */
    void reloadActiveSessionMessages() {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (disposed) {
                return;
            }
            ClaudeSession current = session;
            if (current == null) {
                return;
            }
            String currentId = current.getSessionId();
            if (currentId == null) {
                return;
            }
            if (streamCoalescer != null && streamCoalescer.isStreamActive()) {
                deferredReload.defer(currentId);
                LOG.info("[ClaudeChatWindow] Same-session resume deferred — "
                        + "turn streaming, will reload at stream end, sessionId=" + currentId);
                return;
            }
            LOG.info("[ClaudeChatWindow] Same-session resume soft reload (no interrupt), sessionId=" + currentId);
            requestSessionReload(currentId);
        });
    }

    private ChatWindowDelegate.DelegateHost createDelegateHost() {
        return new ChatWindowDelegate.DelegateHost() {
            @Override
            public Project getProject() {
                return project;
            }

            @Override
            public ClaudeSDKBridge getClaudeSDKBridge() {
                return claudeSDKBridge;
            }

            @Override
            public CodexSDKBridge getCodexSDKBridge() {
                return codexSDKBridge;
            }

            @Override
            public ClaudeSession getSession() {
                return session;
            }

            @Override
            public CodemossSettingsService getSettingsService() {
                return settingsService;
            }

            @Override
            public JPanel getMainPanel() {
                return mainPanel;
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public Content getParentContent() {
                return parentContent;
            }

            @Override
            public String getOriginalTabName() {
                return originalTabName;
            }

            @Override
            public void setOriginalTabName(String name) {
                ClaudeChatWindow.this.setOriginalTabName(name);
            }

            @Override
            public String getSessionId() {
                return sessionId;
            }

            @Override
            public boolean isActiveContent() {
                return ClaudeChatWindow.this.isActiveContent();
            }

            @Override
            public void activateContent() {
                ClaudeChatWindow.this.activateContent();
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public void setHandlerContext(HandlerContext ctx) {
                handlerContext = ctx;
            }

            @Override
            public void setMessageDispatcher(MessageDispatcher d) {
                messageDispatcher = d;
            }

            @Override
            public void setPermissionHandler(PermissionHandler h) {
                permissionHandler = h;
            }

            @Override
            public void setHistoryHandler(HistoryHandler h) {
                historyHandler = h;
            }

            @Override
            public SessionLifecycleManager getSessionLifecycleManager() {
                return sessionLifecycleManager;
            }

            @Override
            public StreamMessageCoalescer getStreamCoalescer() {
                return streamCoalescer;
            }

            @Override
            public WebviewWatchdog getWebviewWatchdog() {
                return webviewWatchdog;
            }

            @Override
            public PermissionHandler getPermissionHandler() {
                return permissionHandler;
            }

            @Override
            public void callJavaScript(String fn, String... args) {
                ClaudeChatWindow.this.callJavaScript(fn, args);
            }

            @Override
            public void interruptDueToPermissionDenial() {
                ClaudeChatWindow.this.interruptDueToPermissionDenial();
            }

            @Override
            public boolean isFrontendReady() {
                return frontendReady;
            }

            @Override
            public void setFrontendReady(boolean ready) {
                updateFrontendReadyState(ready);
            }

            @Override
            public void setSlashCommandsFetched(boolean fetched) {
                slashCommandsFetched = fetched;
            }

            @Override
            public void setFetchedSlashCommandsCount(int count) {
                fetchedSlashCommandsCount = count;
            }

            @Override
            public void persistTabSessionState() {
                ClaudeChatWindow.this.persistTabSessionState();
            }

            @Override
            public void manualResumeAutoResume() {
                if (autoResumeController != null) {
                    autoResumeController.manualResume();
                }
            }

            @Override
            public void scheduleSend(String message, long fireAt) {
                if (scheduledSendController == null) {
                    return;
                }
                ScheduledSendController.Result result = scheduledSendController.schedule(message, fireAt);
                String errorCode = scheduleErrorCode(result);
                if (errorCode != null) {
                    // Rejected requests leave the schedule untouched, so report the
                    // reason alongside the state the tab still has.
                    LOG.info("[ScheduledSend] Rejected schedule request: " + result);
                    pushScheduledSendStatus(scheduledSendController.isArmed(),
                            scheduledSendController.getFireAtMs(),
                            scheduledSendController.getMessage(), false, errorCode);
                }
            }

            @Override
            public void cancelScheduledSend() {
                missedScheduledSendText = null;
                if (scheduledSendController != null) {
                    scheduledSendController.cancel();
                }
                pushCurrentScheduledSendStatus();
            }

            @Override
            public void sendScheduledNow() {
                if (scheduledSendController != null) {
                    scheduledSendController.sendNow(missedScheduledSendText);
                }
            }

            @Override
            public void requestScheduledSendStatus() {
                pushCurrentScheduledSendStatus();
            }

            @Override
            public void reloadActiveSessionMessages() {
                ClaudeChatWindow.this.reloadActiveSessionMessages();
            }
        };
    }
}
