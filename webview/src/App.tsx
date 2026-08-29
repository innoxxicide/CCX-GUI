import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import { sendBridgeEvent } from './utils/bridge';
import { preloadSlashCommands, forceRefreshPrompts } from './components/ChatInputBox/providers';
import {
  useScrollBehavior,
  useSessionManagement,
  useStreamingMessages,
  useWindowCallbacks,
  useRewindHandlers,
  useHistoryLoader,
  useMessageQueue,
  useThemeInit,
  useContextActions,
  useMessageProcessing,
  useMessageSender,
  useModelProviderState,
  useChatComputations,
  useClaudeLimitsRefresh,
} from './hooks';
import {
  NEW_SESSION_COMMANDS,
  RESUME_COMMANDS,
  PLAN_COMMANDS,
  CONTEXT_COMMANDS,
} from './hooks/useMessageSender';
import { applyDiffTheme, getStoredDiffTheme } from './utils/diffTheme';
import { collectTaskEventsFromMessages } from './utils/taskNotificationMessage';
import type { ClaudeMessage } from './types';
import type { Attachment, ChatInputBoxHandle, SubmitOptions } from './components/ChatInputBox/types';
import {
  apply1MContextSuffix,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from './components/ChatInputBox/types';
import { ToastContainer } from './components/Toast';
import { ChatHeader } from './components/ChatHeader';
import { ChatScreen } from './components/ChatScreen';
import type { MessageListRevealHandle } from './components/ConversationSearch/types';
import { useSubagentContextValues, useSetTaskEvents } from './contexts/SubagentContext';
import { useMessages } from './contexts/MessagesContext';
import { useSession } from './contexts/SessionContext';
import { useUIState } from './contexts/UIStateContext';
import { useDialogs } from './contexts/DialogContext';
import { AppDialogs } from './components/AppDialogs';
import { UsageStatsModal } from './components/UsageStatsModal/UsageStatsModal';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from './utils/permissionDialogTimeout';

const App = () => {
  const { t } = useTranslation();

  // ── Dialog management (extracted to DialogContext, stage 4 of TASK-P1-01) ──
  // Open* / set* are still needed by hooks (useWindowCallbacks, useRewindHandlers).
  // Display state (permissionDialogOpen / askUserQuestionDialogOpen / etc.) is
  // consumed directly inside <AppDialogs> via useDialogs().
  const {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
    openContextUsageDialog,
    updateContextUsageData,
    closeContextUsageDialog,
    setRewindDialogOpen, setCurrentRewindRequest,
    isRewinding, setIsRewinding, setRewindSelectDialogOpen,
  } = useDialogs();

  // ── Messages flow state (extracted to MessagesContext, stage 1 of TASK-P1-01) ──
  // Display state (loadingStartTime / isThinking) is consumed inside <ChatScreen>.
  const {
    messages, setMessages,
    subagentHistories, setSubagentHistories,
    setStatus,
    loading, setLoading, setLoadingStartTime,
    setIsThinking,
    streamingActive, setStreamingActive,
  } = useMessages();

  // task_events live in TaskEventProvider (SubagentContext) so their updates do
  // not re-render every MessagesContext consumer.
  const setTaskEvents = useSetTaskEvents();

  // ── Session state (extracted to SessionContext, stage 2 of TASK-P1-01) ──
  const {
    currentSessionId, setCurrentSessionId,
    customSessionTitle, setCustomSessionTitle,
    historyData, setHistoryData,
    currentSessionIdRef, customSessionTitleRef,
  } = useSession();

  // ── UI state (extracted to UIStateContext, stage 3 of TASK-P1-01) ──
  // Dialog visibility (addModelDialog / changelog) is consumed inside AppDialogs.
  const {
    currentView, setCurrentView,
    settingsInitialTab, setSettingsInitialTab,
    toasts, addToast, dismissToast, clearToasts,
    setContextInfo,
    searchOpen, setSearchOpen,
    usageStatsModalOpen, setUsageStatsModalOpen,
  } = useUIState();

  // ── Permission dialog timeout (synced with backend config) ──
  const [permissionDialogTimeoutSeconds, setPermissionDialogTimeoutSeconds] = useState(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
  // When false, permission/question/plan dialogs wait indefinitely (no countdown, no safety net).
  const [autoCloseDialogOnTimeout, setAutoCloseDialogOnTimeout] = useState(true);

  // ── Local refs (don't trigger re-render, kept in App.tsx) ──
  const isFirstMountRef = useRef(true);
  const chatInputRef = useRef<ChatInputBoxHandle>(null);

  // StatusPanel collapse state — kept in App.tsx because forceStatusUpdate is
  // intentionally local: a tiny re-render trigger paired with userCollapsedRef.
  const userCollapsedRef = useRef(false);
  const [, forceStatusUpdate] = useState(0);

  // Message anchor node registry for anchor rail navigation
  const messageNodeMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [anchorCollapsedCount, setAnchorCollapsedCount] = useState(0);
  const handleMessageNodeRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) { messageNodeMapRef.current.set(id, node); }
    else { messageNodeMapRef.current.delete(id); }
  }, []);

  // Imperative handle for the in-page search panel to expand collapsed earlier messages.
  const messageListRef = useRef<MessageListRevealHandle | null>(null);

  // ── Theme & context actions ──
  useThemeInit();
  useContextActions();

  // Apply diff theme on app startup so diff styles work before opening Settings.
  useEffect(() => {
    const ideTheme = window.__INITIAL_IDE_THEME__ ?? null;
    applyDiffTheme(getStoredDiffTheme(), ideTheme);
  }, []);

  // ── Scroll behavior ──
  const {
    messagesContainerRef, messagesEndRef, inputAreaRef,
    isUserAtBottomRef, isAutoScrollingRef, userPausedRef,
  } = useScrollBehavior({ currentView, messages, loading, streamingActive });

  // ── Streaming messages ──
  const {
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    streamingMessageIndexRef, contentUpdateTimeoutRef, thinkingUpdateTimeoutRef,
    lastContentUpdateRef, lastThinkingUpdateRef, autoExpandedThinkingKeysRef,
    streamingTurnIdRef, turnIdCounterRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
  } = useStreamingMessages();

  // (Toast helpers moved to UIStateContext)

  // ── Model/Provider state ──
  const {
    currentProvider, selectedModel, permissionMode,
    selectedAgent, sdkStatusLoading, sdkStatusError, currentSdkInstalled,
    claudeSdkMeetsMinimum,
    currentProviderRef,
    activeProviderConfig, claudeSettingsAlwaysThinkingEnabled,
    reasoningEffort, codexFastMode, streamingEnabledSetting, sendShortcut, autoOpenFileEnabled,
    longContextEnabled,
    usagePercentage, usageUsedTokens, usageMaxTokens,
    claudeLimits, setClaudeLimits,
    setPermissionMode, setCurrentProvider,
    setClaudePermissionMode, setCodexPermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setSelectedGrokModel, setSelectedKimiModel,
    setSelectedOpenCodeModel, setSelectedPiModel, setSelectedDshModel,
    setLongContextEnabled, setReasoningEffort, setCodexFastMode,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled, setStreamingEnabledSetting,
    setSendShortcut, setAutoOpenFileEnabled,
    setSdkStatus, setSdkStatusLoaded, setSdkStatusError, retrySdkStatus, setSelectedAgent,
    setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    syncActiveProviderModelMapping,
    handleModeSelect, handleModelSelect, handleProviderSelect,
    handleReasoningChange, handleCodexFastModeChange, handleAgentSelect, handleToggleThinking,
    handleStreamingEnabledChange, handleSendShortcutChange,
    handleAutoOpenFileEnabledChange, handleLongContextChange,
  } = useModelProviderState({ addToast, t });

  // ── Global drag event interception ──
  useEffect(() => {
    const preventExternalDrop = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      const isExternalDrop = types.includes('Files') || types.includes('text/uri-list');
      if (!isExternalDrop) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dragover', preventExternalDrop);
    document.addEventListener('drop', preventExternalDrop);
    document.addEventListener('dragenter', preventExternalDrop);
    return () => {
      document.removeEventListener('dragover', preventExternalDrop);
      document.removeEventListener('drop', preventExternalDrop);
      document.removeEventListener('dragenter', preventExternalDrop);
    };
  }, []);

  // ── Close in-conversation search panel when navigating away from chat ──
  // Split from the hotkey effect below so that toggling `searchOpen` does
  // NOT rebind the global keydown listener every time the panel opens/closes.
  useEffect(() => {
    if (currentView !== 'chat' && searchOpen) {
      setSearchOpen(false);
    }
  }, [currentView, searchOpen, setSearchOpen]);

  // ── In-conversation search hotkey (Cmd+F on macOS, Ctrl+F elsewhere) ──
  // Only active in chat view. Settings / history use their own search
  // (HistoryFilters) or none at all — we deliberately let the platform
  // handle Cmd+F there.
  //
  // We deliberately listen for ONLY the platform-appropriate modifier:
  // macOS users use Ctrl+F as the Emacs-style "forward-char" cursor move,
  // so we MUST NOT capture Ctrl+F on macOS. This is a real regression
  // surfaced by code review.
  //
  // Platform detection prefers `navigator.userAgentData.platform` (modern,
  // non-deprecated) and falls back to `userAgent` string sniffing for
  // JCEF / older Chromium where userAgentData may be unavailable.
  // `navigator.platform` is intentionally NOT used — it is deprecated and
  // returns inconsistent values inside JCEF.
  useEffect(() => {
    if (currentView !== 'chat') return;
    const isMac = (() => {
      if (typeof navigator === 'undefined') return false;
      const uaData = (navigator as Navigator & {
        userAgentData?: { platform?: string };
      }).userAgentData;
      const platform = uaData?.platform ?? navigator.userAgent ?? '';
      return /mac|iphone|ipad|ipod/i.test(platform);
    })();
    const handler = (e: KeyboardEvent) => {
      const key = e.key;
      if (key !== 'f' && key !== 'F') return;
      const isFind = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
      if (!isFind) return;
      // Don't fight IME composition.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
    // setSearchOpen is a stable useState setter; intentionally omitted from
    // deps so we don't rebind the global listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);

  // ── Slash command preloading ──
  useEffect(() => {
    preloadSlashCommands();
    forceRefreshPrompts();
    const retryTimer = setTimeout(() => { forceRefreshPrompts(); }, 1000);
    return () => clearTimeout(retryTimer);
  }, []);

  useEffect(() => {
    if (isFirstMountRef.current) { isFirstMountRef.current = false; return; }
    if (currentView === 'chat') { forceRefreshPrompts(); }
  }, [currentView]);

  // Recover task events from task-notification user messages. Recent Claude Code
  // delivers a background agent's terminal report as a plain user message (XML
  // in content) instead of an SDK task_notification event, so history replay —
  // and any live session that never fired the SDK path — would otherwise leave
  // the subagent card stuck on the launch ack text. Derived entries only fill
  // gaps: a real SDK event already in the map is kept as-is.
  // Messages update immutably, so unchanged messages keep their object identity;
  // tracking scanned objects avoids re-scanning the whole conversation on every
  // streaming chunk.
  const scannedTaskNotificationMessagesRef = useRef(new WeakSet<ClaudeMessage>());
  useEffect(() => {
    const scanned = scannedTaskNotificationMessagesRef.current;
    const fresh = messages.filter((m) => !scanned.has(m));
    if (fresh.length === 0) return;
    for (const m of fresh) scanned.add(m);
    const derived = collectTaskEventsFromMessages(fresh);
    if (Object.keys(derived).length === 0) return;
    setTaskEvents((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, event] of Object.entries(derived)) {
        if (next[id]) continue;
        next[id] = event;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [messages, setTaskEvents]);

  // ── Session management ──
  const {
    showNewSessionConfirm, showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession, forceCreateNewSession,
    forceCreateNewSessionWithProvider,
    handleConfirmNewSession, handleCancelNewSession,
    handleConfirmInterrupt, handleCancelInterrupt,
    loadHistorySession, deleteHistorySession, deleteHistorySessions, exportHistorySession,
    toggleFavoriteSession, updateHistoryTitle, applyHistoryTitleLocal, convertToCliSession,
  } = useSessionManagement({
    messages, loading, historyData, currentSessionId, currentSessionIdRef, currentProvider,
    setHistoryData, setMessages, setCurrentView, setCurrentSessionId,
    setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setStatus, setLoading, setIsThinking, setStreamingActive,
    setTaskEvents,
    setSubagentHistories,
    clearToasts, addToast, t,
    applyHistoryModel: (provider, model, agent) => {
      // Switch provider first when history row differs, then apply model.
      if (provider && provider !== currentProvider) {
        handleProviderSelect(provider);
      }
      if (model) {
        // handleModelSelect reads currentProvider; after provider switch state
        // may not have flushed yet — send bridge + setter for the target provider.
        if (provider === 'codex') {
          setSelectedCodexModel(model);
          sendBridgeEvent('set_model', model);
        } else if (provider === 'grok') {
          setSelectedGrokModel(model);
          sendBridgeEvent('set_model', model);
        } else if (provider === 'kimi') {
          setSelectedKimiModel(model);
          sendBridgeEvent('set_model', model);
        } else if (provider === 'opencode') {
          setSelectedOpenCodeModel(model);
          sendBridgeEvent('set_model', model);
        } else if (provider === 'pi') {
          setSelectedPiModel(model);
          sendBridgeEvent('set_model', model);
        } else if (provider === 'dsh') {
          setSelectedDshModel(model);
          sendBridgeEvent('set_model', model);
        } else {
          // claude (or unrecognized): apply the claude model directly —
          // handleModelSelect reads currentProvider from a stale closure
          // right after a provider switch.
          const normalized = normalizeClaudeModelId(strip1MContextSuffix(model));
          setSelectedClaudeModel(normalized);
          sendBridgeEvent('set_model', apply1MContextSuffix(normalized, longContextEnabled));
        }
      }
      if (agent && provider === 'claude') {
        handleAgentSelect({ id: agent, name: agent, prompt: '' });
      }
    },
  });

  useHistoryLoader({ currentView, currentProvider });

  // ── Claude usage limits (5-hour + weekly battery indicators) ──
  // Snapshot requests on provider/session changes and on regaining focus; the
  // backend adds a once-a-minute poll, IDE-window activation, and a push on
  // each agent [USAGE] tag.
  useClaudeLimitsRefresh({
    currentProvider,
    currentSessionId,
    setClaudeLimits,
    setUsageStatsModalOpen,
  });

  // ── Window callbacks (bridge communication) ──
  useWindowCallbacks({
    t, addToast, clearToasts,
    setMessages, setStatus, setLoading, setLoadingStartTime,
    setIsThinking, setStreamingActive, setHistoryData,
    setCurrentSessionId, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setClaudeLimits,
    setPermissionMode, setCurrentProvider, setClaudePermissionMode, setCodexPermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setLongContextEnabled, setReasoningEffort, setCodexFastMode,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled, setStreamingEnabledSetting,
    setSendShortcut, setAutoOpenFileEnabled,
    setSdkStatus, setSdkStatusLoaded, setSdkStatusError,
    setIsRewinding, setRewindDialogOpen, setCurrentRewindRequest,
    setContextInfo, setSelectedAgent,
    setSubagentHistories,
    setTaskEvents,
    currentProviderRef, messagesContainerRef, isUserAtBottomRef, userPausedRef,
    suppressNextStatusToastRef,
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingMessageIndexRef,
    streamingTurnIdRef, turnIdCounterRef,
    lastContentUpdateRef, contentUpdateTimeoutRef,
    lastThinkingUpdateRef, thinkingUpdateTimeoutRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
    syncActiveProviderModelMapping,
    openPermissionDialog, openAskUserQuestionDialog, openPlanApprovalDialog,
    forceClosePermissionDialog, forceCloseAskUserQuestionDialog, forceClosePlanApprovalDialog,
    openContextUsageDialog, updateContextUsageData,
    closeContextUsageDialog,
    customSessionTitleRef, currentSessionIdRef, updateHistoryTitle, applyHistoryTitleLocal,
    setCustomSessionTitle,
    setPermissionDialogTimeoutSeconds,
    setAutoCloseDialogOnTimeout,
  });

  // ── Message processing ──
  const {
    getMessageText, getContentBlocks,
    mergedMessages, sentAttachmentsRef,
  } = useMessageProcessing({ messages, currentSessionId, t });

  // ── Message sender ──
  // Wrap handleProviderSelect to also clear messages and input (like creating a new session)
  const wrappedHandleProviderSelect = useCallback((providerId: string) => {
    chatInputRef.current?.clear();
    handleProviderSelect(providerId);
    forceCreateNewSessionWithProvider(providerId);
  }, [forceCreateNewSessionWithProvider, handleProviderSelect]);

  const {
    handleSubmit: hookHandleSubmit,
    executeMessage,
    interruptSession,
  } = useMessageSender({
    t, addToast,
    currentProvider, selectedModel, permissionMode, reasoningEffort, selectedAgent, codexFastMode,
    sdkStatusLoading, currentSdkInstalled,
    sentAttachmentsRef, chatInputRef, messagesContainerRef,
    isUserAtBottomRef, userPausedRef, isStreamingRef,
    setMessages, setLoading, setLoadingStartTime, setStreamingActive,
    setSettingsInitialTab, setCurrentView,
    forceCreateNewSession,
    handleModeSelect,
    longContextEnabled,
    openContextUsageDialog,
    closeContextUsageDialog,
  });

  // ── Message queue ──
  const {
    queue: messageQueue,
    enqueue: enqueueMessage,
    enqueueFront: enqueueMessageFront,
    dequeue: dequeueMessage,
  } = useMessageQueue({ isLoading: loading, onExecute: executeMessage });

  /**
   * "Send now" — intervene in a session that is already working, instead of
   * queueing the message behind the running turn.
   *
   * Stops the turn and puts the message at the head of the queue, where the
   * existing drain-on-loading-edge picks it up. Going through the queue rather
   * than calling executeMessage directly is what keeps the interrupt and the
   * send from racing: one loading edge, one drain, one send. Anything already
   * queued keeps its order behind this message.
   *
   * Stopping first is not a shortcut — handing a message to a live turn without
   * stopping it is not something the agent CLIs support; see SubmitOptions.
   */
  const sendImmediately = useCallback((content: string, attachments?: Attachment[]) => {
    enqueueMessageFront(content, attachments);
    interruptSession();
  }, [enqueueMessageFront, interruptSession]);

  // handleSubmit with queue support (new session and local commands bypass loading check)
  const handleSubmit = useCallback((content: string, attachments?: Attachment[], options?: SubmitOptions) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!text && !hasAttachments) return;
    // Local commands work even while loading
    if (text.startsWith('/')) {
      const command = text.split(/\s+/)[0].toLowerCase();
      // New session commands
      if (NEW_SESSION_COMMANDS.has(command)) {
        forceCreateNewSession();
        return;
      }
      // /resume - open history view
      if (RESUME_COMMANDS.has(command)) {
        setCurrentView('history');
        return;
      }
      // /plan - switch to plan mode (Claude only; Codex sends as normal text)
      if (PLAN_COMMANDS.has(command) && currentProvider === 'claude') {
        handleModeSelect('plan');
        addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
        return;
      }
      // /context - handled locally even while loading
      if (CONTEXT_COMMANDS.has(command)) {
        hookHandleSubmit(content, attachments);
        return;
      }
    }
    // If loading, either interrupt into the running turn or add to the queue
    if (loading) {
      if (options?.immediate) {
        sendImmediately(content, attachments);
        return;
      }
      enqueueMessage(content, attachments);
      return;
    }
    hookHandleSubmit(content, attachments);
  }, [loading, enqueueMessage, sendImmediately, hookHandleSubmit, forceCreateNewSession, currentProvider, handleModeSelect, setCurrentView, addToast, t]);

  // ── Chat-view computations (stage 5 of TASK-P1-01) ──
  const {
    findToolResult, getToolResultRaw,
    fileChangeMgmt,
    filteredFileChanges, subagents, globalTodos, rewindableMessages, sessionTitle,
  } = useChatComputations({
    t, messages, mergedMessages, subagentHistories, customSessionTitle, streamingActive, currentProvider,
    currentSessionId, currentSessionIdRef,
    getMessageText, getContentBlocks,
  });

  const { handleUndoFile, handleDiscardAll: handleDiscardAllRaw, handleKeepAll } = fileChangeMgmt;
  const onDiscardAll = useCallback(
    () => { handleDiscardAllRaw(filteredFileChanges); },
    [handleDiscardAllRaw, filteredFileChanges],
  );

  // Stabilize context value references for SubagentContext consumers.
  const { subagentHistoryCtxValue, sessionIdCtxValue } = useSubagentContextValues(
    subagentHistories,
    currentSessionId,
    currentProvider,
  );

  const handleNavigateToProviderSettings = useCallback(() => {
    setSettingsInitialTab('providers');
    setCurrentView('settings');
  }, [setSettingsInitialTab, setCurrentView]);

  const handleNavigateToSdkSettings = useCallback(() => {
    setSettingsInitialTab('dependencies');
    setCurrentView('settings');
  }, [setSettingsInitialTab, setCurrentView]);

  // Warn once when the installed Claude SDK is below the Fable minimum (0.3.182)
  // and the Fable tier is selected. Old CLIs don't recognize the 'fable' alias
  // and pass it through as a literal model name, which 401s on third-party relays
  // ("model fable" / "No available channel"). `claudeSdkMeetsMinimum` is `undefined`
  // until the backend reports status or when the SDK isn't installed — never warn
  // in those cases to avoid false positives.
  const fableSdkWarningShownRef = useRef(false);
  useEffect(() => {
    if (
      currentProvider === 'claude' &&
      currentSdkInstalled &&
      claudeSdkMeetsMinimum === false &&
      /fable/i.test(selectedModel ?? '') &&
      !fableSdkWarningShownRef.current
    ) {
      fableSdkWarningShownRef.current = true;
      addToast(t('chat.sdkTooLowForFable'), 'warning', {
        label: t('chat.updateSdk'),
        onClick: handleNavigateToSdkSettings,
      });
    }
  }, [currentProvider, currentSdkInstalled, claudeSdkMeetsMinimum, selectedModel, addToast, t, handleNavigateToSdkSettings]);

  // ── Rewind handlers ──
  const {
    handleRewindConfirm, handleRewindCancel,
    handleOpenRewindSelectDialog, handleRewindSelect, handleRewindSelectCancel,
  } = useRewindHandlers({
    t, addToast, currentSessionId, mergedMessages, getMessageText,
    setCurrentRewindRequest, setRewindDialogOpen, setRewindSelectDialogOpen,
    setIsRewinding, isRewinding,
  });

  const statusPanelExpanded = !userCollapsedRef.current;

  // ── Render ──
  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <ChatHeader
        currentView={currentView}
        sessionTitle={sessionTitle}
        t={t}
        onBack={() => setCurrentView('chat')}
        onNewSession={createNewSession}
        onNewTab={() => sendBridgeEvent('create_new_tab')}
        onHistory={() => setCurrentView('history')}
        onSettings={() => {
          setSettingsInitialTab(undefined);
          setCurrentView('settings');
        }}
        onOpenSearch={() => setSearchOpen(true)}
        titleEditable
        onTitleChange={(newTitle) => {
          setCustomSessionTitle(newTitle);
          if (currentSessionId) {
            updateHistoryTitle(currentSessionId, newTitle);
          }
        }}
        showClaudeLimits={currentProvider === 'claude'}
        subagents={subagents}
        claudeLimits={claudeLimits}
        onUsageStatsClick={() => {
          setUsageStatsModalOpen(true);
          sendBridgeEvent('get_claude_limits', 'force');
        }}
      />

      {currentView === 'settings' ? (
        <SettingsView
          onClose={() => setCurrentView('chat')}
          initialTab={settingsInitialTab}
          currentProvider={currentProvider}
          streamingEnabled={streamingEnabledSetting}
          onStreamingEnabledChange={handleStreamingEnabledChange}
          sendShortcut={sendShortcut}
          onSendShortcutChange={handleSendShortcutChange}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
          permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
          onPermissionDialogTimeoutChange={setPermissionDialogTimeoutSeconds}
          autoCloseDialogOnTimeout={autoCloseDialogOnTimeout}
          onAutoCloseDialogOnTimeoutChange={setAutoCloseDialogOnTimeout}
        />
      ) : (
        <>
          {/* Keep ChatScreen mounted while browsing history so model catalog,
              scroll position, and draft attachments survive history ↔ chat. */}
          <div
            style={currentView === 'chat'
              ? { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }
              : { display: 'none' }}
          >
            <ChatScreen
              mergedMessages={mergedMessages}
              sessionTitle={sessionTitle}
              getMessageText={getMessageText}
              getContentBlocks={getContentBlocks}
              findToolResult={findToolResult}
              getToolResultRaw={getToolResultRaw}
              subagents={subagents}
              globalTodos={globalTodos}
              filteredFileChanges={filteredFileChanges}
              subagentHistoryCtxValue={subagentHistoryCtxValue}
              sessionIdCtxValue={sessionIdCtxValue}
              chatInputRef={chatInputRef}
              messagesContainerRef={messagesContainerRef}
              messagesEndRef={messagesEndRef}
              inputAreaRef={inputAreaRef}
              messageNodeMapRef={messageNodeMapRef}
              userCollapsedRef={userCollapsedRef}
              messageListRef={messageListRef}
              isAutoScrollingRef={isAutoScrollingRef}
              anchorCollapsedCount={anchorCollapsedCount}
              setAnchorCollapsedCount={setAnchorCollapsedCount}
              onMessageNodeRef={handleMessageNodeRef}
              statusPanelExpanded={statusPanelExpanded}
              forceStatusUpdate={forceStatusUpdate}
              onUndoFile={handleUndoFile}
              onDiscardAll={onDiscardAll}
              onKeepAll={handleKeepAll}
              onSubmit={handleSubmit}
              onInterrupt={interruptSession}
              onRewind={handleOpenRewindSelectDialog}
              onNavigateToProviderSettings={handleNavigateToProviderSettings}
              onProviderSelect={wrappedHandleProviderSelect}
              currentProvider={currentProvider}
              selectedModel={selectedModel}
              permissionMode={permissionMode}
              selectedAgent={selectedAgent}
              sdkStatusLoading={sdkStatusLoading}
              sdkStatusError={sdkStatusError}
              onRetrySdkStatus={retrySdkStatus}
              currentSdkInstalled={currentSdkInstalled}
              activeProviderConfig={activeProviderConfig}
              claudeSettingsAlwaysThinkingEnabled={claudeSettingsAlwaysThinkingEnabled}
              reasoningEffort={reasoningEffort}
              codexFastMode={codexFastMode}
              streamingEnabledSetting={streamingEnabledSetting}
              sendShortcut={sendShortcut}
              autoOpenFileEnabled={autoOpenFileEnabled}
              longContextEnabled={longContextEnabled}
              usagePercentage={usagePercentage}
              usageUsedTokens={usageUsedTokens}
              usageMaxTokens={usageMaxTokens}
              onModeSelect={handleModeSelect}
              onModelSelect={handleModelSelect}
              onAgentSelect={handleAgentSelect}
              onReasoningChange={handleReasoningChange}
              onCodexFastModeChange={handleCodexFastModeChange}
              onToggleThinking={handleToggleThinking}
              onStreamingEnabledChange={handleStreamingEnabledChange}
              onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
              onLongContextChange={handleLongContextChange}
              messageQueue={messageQueue}
              onRemoveFromQueue={dequeueMessage}
            />
          </div>
          {currentView === 'history' && (
            <HistoryView
              historyData={historyData}
              currentProvider={currentProvider}
              currentSessionId={currentSessionId}
              onLoadSession={loadHistorySession}
              onDeleteSession={deleteHistorySession}
              onDeleteSessions={deleteHistorySessions}
              onExportSession={exportHistorySession}
              onToggleFavorite={toggleFavoriteSession}
              onUpdateTitle={updateHistoryTitle}
              onConvertToCliSession={convertToCliSession}
            />
          )}
        </>
      )}

      <div id="image-preview-root" />

      <AppDialogs
        showNewSessionConfirm={showNewSessionConfirm}
        onConfirmNewSession={handleConfirmNewSession}
        onCancelNewSession={handleCancelNewSession}
        showInterruptConfirm={showInterruptConfirm}
        onConfirmInterrupt={handleConfirmInterrupt}
        onCancelInterrupt={handleCancelInterrupt}
        rewindableMessages={rewindableMessages}
        onRewindSelect={handleRewindSelect}
        onRewindSelectCancel={handleRewindSelectCancel}
        onRewindConfirm={handleRewindConfirm}
        onRewindCancel={handleRewindCancel}
        currentProvider={currentProvider}
        permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
        autoCloseDialogOnTimeout={autoCloseDialogOnTimeout}
      />

      <UsageStatsModal
        isOpen={usageStatsModalOpen}
        onClose={() => setUsageStatsModalOpen(false)}
        limits={claudeLimits}
        onRefresh={() => sendBridgeEvent('get_claude_limits', 'force')}
      />
    </>
  );
};

export default App;
