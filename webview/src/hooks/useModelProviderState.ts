import { useCallback, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { PermissionMode } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useGrokProvider } from './providers/useGrokProvider';
import { useKimiProvider } from './providers/useKimiProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { usePiProvider } from './providers/usePiProvider';
import { useDshProvider } from './providers/useDshProvider';
import { isCliOnlyProvider, normalizeCliPermissionMode } from './providers/cliProviders';
import { useUsageTracking } from './providers/useUsageTracking';
import { useClaudeLimits } from './providers/useClaudeLimits';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state. Composes four single-purpose
 * sub-hooks (Claude / Codex / usage tracking / provider settings) plus a
 * persistence hook, then wires the cross-slice state (currentProvider +
 * permissionMode) and the cross-provider handlers (mode/model/provider switch,
 * long-context toggle, always-thinking toggle).
 *
 * The flat return shape is preserved as the public API: callers (App,
 * ChatScreen, AppDialogs, useMessageSender) destructure individual fields.
 *
 * `currentProviderRef` is exposed for window callbacks registered with stable
 * identity that must read the current provider when fired by the JCEF bridge.
 * The ref is updated via render-time assignment (no useEffect mirror).
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Render-time assignment avoids the useRef + useEffect
  // mirror anti-pattern (rule 5.15).
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const grok = useGrokProvider();
  const kimi = useKimiProvider();
  const openCode = useOpenCodeProvider();
  const pi = usePiProvider();
  const dsh = useDshProvider();
  const { isSdkInstalled, isSdkStatusKnown, sdkStatus, ...usage } = useUsageTracking();
  const claudeLimits = useClaudeLimits();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
  } = codex;
  const {
    selectedGrokModel, setSelectedGrokModel,
    grokPermissionMode, setGrokPermissionMode,
  } = grok;
  const {
    selectedKimiModel, setSelectedKimiModel,
    kimiPermissionMode, setKimiPermissionMode,
  } = kimi;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;
  const {
    selectedPiModel, setSelectedPiModel,
    piPermissionMode, setPiPermissionMode,
  } = pi;
  const {
    selectedDshModel, setSelectedDshModel,
    dshPermissionMode, setDshPermissionMode,
  } = dsh;

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedDshModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setDshPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedDshModel,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    dshPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
  });

  // ── Computed values ──
  const selectedModel = currentProvider === 'codex'
    ? selectedCodexModel
    : currentProvider === 'grok'
      ? selectedGrokModel
      : currentProvider === 'kimi'
        ? selectedKimiModel
        : currentProvider === 'opencode'
          ? selectedOpenCodeModel
          : currentProvider === 'pi'
            ? selectedPiModel
            : currentProvider === 'dsh'
              ? selectedDshModel
            : selectedClaudeModel;
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );
  const currentSdkStatusError = useMemo(
    () => usage.sdkStatusError !== null && !isSdkStatusKnown(currentProvider)
      ? usage.sdkStatusError
      : null,
    [currentProvider, isSdkStatusKnown, usage.sdkStatusError],
  );
  // Whether the installed Claude SDK meets the minimum version required for the
  // selected model's tier (Fable needs >= 0.3.182). `undefined` means the backend
  // hasn't reported it (SDK not installed, or an old plugin version without the
  // field) — callers must only warn on an explicit `false` to avoid false positives.
  const claudeSdkMeetsMinimum = sdkStatus?.['claude-sdk']?.meetsMinimumVersion;

  // ── Cross-provider handlers ──
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode: PermissionMode = mode === 'plan' ? 'default' : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      const cliMode = normalizeCliPermissionMode(mode);
      setPermissionMode(cliMode);
      if (currentProvider === 'grok') setGrokPermissionMode(cliMode);
      if (currentProvider === 'kimi') setKimiPermissionMode(cliMode);
      if (currentProvider === 'opencode') setOpenCodePermissionMode(cliMode);
      if (currentProvider === 'pi') setPiPermissionMode(cliMode);
      if (currentProvider === 'dsh') setDshPermissionMode(cliMode);
      sendBridgeEvent('set_mode', cliMode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    setCodexPermissionMode,
    setClaudePermissionMode,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setDshPermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'grok') {
      setSelectedGrokModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'kimi') {
      setSelectedKimiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'opencode') {
      setSelectedOpenCodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'pi') {
      setSelectedPiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'dsh') {
      setSelectedDshModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, [
    currentProvider,
    longContextEnabled,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedDshModel,
  ]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    let modeToSet: PermissionMode = claudePermissionMode;
    if (providerId === 'codex') {
      modeToSet = normalizeCliPermissionMode(codexPermissionMode);
    } else if (providerId === 'grok') {
      modeToSet = normalizeCliPermissionMode(grokPermissionMode);
    } else if (providerId === 'kimi') {
      modeToSet = normalizeCliPermissionMode(kimiPermissionMode);
    } else if (providerId === 'opencode') {
      modeToSet = normalizeCliPermissionMode(openCodePermissionMode);
    } else if (providerId === 'pi') {
      modeToSet = normalizeCliPermissionMode(piPermissionMode);
    } else if (providerId === 'dsh') {
      modeToSet = normalizeCliPermissionMode(dshPermissionMode);
    }
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    let newModel = apply1MContextSuffix(selectedClaudeModel, longContextEnabled);
    if (providerId === 'codex') newModel = selectedCodexModel;
    else if (providerId === 'grok') newModel = selectedGrokModel;
    else if (providerId === 'kimi') newModel = selectedKimiModel;
    else if (providerId === 'opencode') newModel = selectedOpenCodeModel;
    else if (providerId === 'pi') newModel = selectedPiModel;
    else if (providerId === 'dsh') newModel = selectedDshModel;
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    dshPermissionMode,
    selectedCodexModel,
    selectedClaudeModel,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedDshModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...grok,
    ...kimi,
    ...openCode,
    ...pi,
    ...dsh,
    ...usage,
    ...claudeLimits,
    ...settings,
    sdkStatus,
    sdkStatusError: currentSdkStatusError,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    currentSdkInstalled,
    claudeSdkMeetsMinimum,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleLongContextChange,
    handleToggleThinking,
  };
}
