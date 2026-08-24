import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelStatePersistence, type UseModelStatePersistenceOptions } from './useModelStatePersistence';
import { DEFAULT_CLAUDE_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function makeOptions(overrides: Partial<UseModelStatePersistenceOptions> = {}): UseModelStatePersistenceOptions {
  return {
    setCurrentProvider: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedGrokModel: vi.fn(),
    setSelectedKimiModel: vi.fn(),
    setSelectedOpenCodeModel: vi.fn(),
    setSelectedPiModel: vi.fn(),
    setSelectedDshModel: vi.fn(),
    setGrokPermissionMode: vi.fn(),
    setKimiPermissionMode: vi.fn(),
    setOpenCodePermissionMode: vi.fn(),
    setPiPermissionMode: vi.fn(),
    setDshPermissionMode: vi.fn(),
    setPermissionMode: vi.fn(),
    setLongContextEnabled: vi.fn(),
    setReasoningEffort: vi.fn(),
    setCodexFastMode: vi.fn(),
    currentProvider: 'claude',
    selectedClaudeModel: 'claude-sonnet-4-5',
    selectedCodexModel: 'gpt-5-codex',
    claudePermissionMode: 'default' as PermissionMode,
    codexPermissionMode: 'default' as PermissionMode,
    selectedGrokModel: 'grok-4.6',
    selectedKimiModel: 'auto',
    selectedOpenCodeModel: 'opencode-default',
    selectedPiModel: 'auto',
    selectedDshModel: 'auto',
    grokPermissionMode: 'default' as PermissionMode,
    kimiPermissionMode: 'default' as PermissionMode,
    openCodePermissionMode: 'default' as PermissionMode,
    piPermissionMode: 'default' as PermissionMode,
    dshPermissionMode: 'default' as PermissionMode,
    longContextEnabled: false,
    reasoningEffort: 'medium',
    codexFastMode: 'normal',
    ...overrides,
  };
}

function bridgeEventsFor(name: string): unknown[][] {
  return sendBridgeEventMock.mock.calls.filter((c) => c[0] === name);
}

describe('useModelStatePersistence — boot sync does not clobber the persisted permission mode', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete window.__INITIAL_TAB_PROVIDER__;
    delete window.__INITIAL_TAB_MODEL__;
  });

  it('does NOT send set_mode on boot when localStorage was wiped (reinstall)', () => {
    // Reinstall wipes JCEF localStorage → the hook would fall back to 'default'.
    // Pushing that to Java on boot would clobber the app-level PropertiesComponent
    // value (e.g. bypassPermissions) that survives the reinstall — the reported
    // "reinstall forgets Auto" bug. Java is the source of truth via get_mode.
    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200); // fire the deferred syncToBackend

    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
    // Provider/model/codex-fast are webview-owned and must still sync.
    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(1);
  });

  it('does NOT send set_mode on boot even when localStorage carries a non-default mode', () => {
    // Even when the webview snapshot has a valid mode, Java is authoritative on
    // boot (it may hold a newer value); the webview seeds itself from Java via
    // get_mode → onModeReceived, so the boot path must never push the mode down.
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudePermissionMode: 'bypassPermissions',
      permissionMode: 'bypassPermissions',
    }));

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
  });

  it('retries the boot sync until the JCEF bridge is ready, still without set_mode', () => {
    // Bridge not ready yet → the hook retries every 100ms. Mode must never leak
    // into any of the retried sync attempts either.
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    renderHook(() => useModelStatePersistence(makeOptions()));

    vi.advanceTimersByTime(200); // first attempt: bridge missing → schedules retry
    expect(sendBridgeEventMock).not.toHaveBeenCalled();

    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    vi.advanceTimersByTime(100); // retry now succeeds

    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
  });

  it('keeps frontend boot synchronization enabled for a pre-ready startup retry', () => {
    window.__CCGUI_PAGE_LOAD_KIND__ = 'startup_retry';
    window.__CCGUI_RECOVERY_RELOAD__ = false;

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(1);
  });

  it('does not echo the stale HTML provider or model during watchdog recovery', () => {
    window.__CCGUI_RECOVERY_RELOAD__ = true;
    window.__CCGUI_RECOVERY_STATE_APPLIED__ = false;
    window.__INITIAL_TAB_PROVIDER__ = 'codex';
    window.__INITIAL_TAB_MODEL__ = 'gpt-5.6-sol';

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_provider')).toHaveLength(0);
    expect(bridgeEventsFor('set_model')).toHaveLength(0);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(0);
    expect(localStorage.getItem('model-selection-state')).toBeNull();
  });

  it('waits for runtime page context and authoritative recovery state before persisting', () => {
    window.__CCGUI_PAGE_CONTEXT_READY__ = false;
    delete window.__CCGUI_RECOVERY_RELOAD__;

    // The mount pass never writes (it would publish pre-hydration props), so drive a
    // post-mount change and assert the page-context gate on the pass that does write.
    const { rerender } = renderHook(
      (props: { selectedClaudeModel: string }) => useModelStatePersistence(makeOptions(props)),
      { initialProps: { selectedClaudeModel: 'claude-sonnet-4-5' } },
    );
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    act(() => rerender({ selectedClaudeModel: 'claude-opus-5' }));
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    act(() => vi.advanceTimersByTime(100));
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_RECOVERY_RELOAD__ = true;
    act(() => vi.advanceTimersByTime(100));
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    window.__CCGUI_RECOVERY_STATE_APPLIED__ = true;
    act(() => vi.advanceTimersByTime(100));
    expect(JSON.parse(localStorage.getItem('model-selection-state') || '{}').provider).toBe('claude');
  });
});

describe('useModelStatePersistence — retired model migration', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__;
    delete (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__;
  });

  it('migrates a saved retired model (sonnet-4-6) to its replacement instead of the list head', () => {
    // Regression: v0.4.8 removed claude-sonnet-4-6 from CLAUDE_MODELS and put
    // claude-fable-5 first. Saved sonnet-4-6 failed validation and the fallback
    // CLAUDE_MODELS[0] silently reset users to fable-5, which API relays without
    // a fable-5 channel rejected ("No available channel for model claude-fable-5").
    const setSelectedClaudeModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedClaudeModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(setSelectedClaudeModel).not.toHaveBeenCalledWith('claude-fable-5');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-sonnet-5']]);
  });

  it('migrates a backend-supplied retired model via __INITIAL_TAB_MODEL__', () => {
    const setSelectedClaudeModel = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = 'claude';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = 'claude-sonnet-4-6';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedClaudeModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-sonnet-5']]);
  });

  it('falls back to the default model (not the list head) for unrecognized saved models', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-no-such-model',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_model')).toEqual([['set_model', DEFAULT_CLAUDE_MODEL_ID]]);
    expect(DEFAULT_CLAUDE_MODEL_ID).not.toBe('claude-fable-5');
  });
});

describe('useModelStatePersistence — per-tab handoff of the remembered selection', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__;
    delete (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__;
    delete (window as unknown as { __INITIAL_TAB_REASONING_EFFORT__?: unknown }).__INITIAL_TAB_REASONING_EFFORT__;
  });

  it('keeps the remembered model when the backend has no preference for this tab', () => {
    // A tab nobody configured must inject empty strings, not its placeholder
    // default — otherwise every newly opened tab overrides the remembered
    // selection with claude-sonnet-4-7.
    const setSelectedClaudeModel = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = '';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = '';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-opus-5',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedClaudeModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-opus-5');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-opus-5']]);
  });

  it('restores the remembered reasoning effort and reports it to the backend', () => {
    // Java only learns the effort from an explicit dropdown change or a send
    // payload, so a tab that never touched the dropdown had nothing to hand to
    // the next tab. Syncing on boot seeds the per-tab record.
    const setReasoningEffort = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-opus-5',
      reasoningEffort: 'xhigh',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setReasoningEffort })));
    vi.advanceTimersByTime(200);

    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
    expect(bridgeEventsFor('set_reasoning_effort')).toEqual([['set_reasoning_effort', 'xhigh']]);
  });

  it('prefers the backend per-tab reasoning effort over the shared localStorage snapshot', () => {
    const setReasoningEffort = vi.fn();
    (window as unknown as { __INITIAL_TAB_REASONING_EFFORT__?: unknown }).__INITIAL_TAB_REASONING_EFFORT__ = 'low';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-opus-5',
      reasoningEffort: 'xhigh',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setReasoningEffort })));
    vi.advanceTimersByTime(200);

    expect(setReasoningEffort).toHaveBeenLastCalledWith('low');
    expect(bridgeEventsFor('set_reasoning_effort')).toEqual([['set_reasoning_effort', 'low']]);
  });

  it('ignores an unrecognized backend reasoning effort', () => {
    const setReasoningEffort = vi.fn();
    (window as unknown as { __INITIAL_TAB_REASONING_EFFORT__?: unknown }).__INITIAL_TAB_REASONING_EFFORT__ = 'turbo';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      reasoningEffort: 'xhigh',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setReasoningEffort })));
    vi.advanceTimersByTime(200);

    expect(setReasoningEffort).toHaveBeenCalledTimes(1);
    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
  });

  it('does not overwrite the shared snapshot with slice defaults on mount', () => {
    // localStorage is shared by every tab in the JCEF process. The save effect
    // runs in the same commit as hydration and still sees the pre-hydration
    // props, so writing on mount would hand slice defaults to any tab booting
    // at that moment.
    const saved = {
      provider: 'codex',
      claudeModel: 'claude-opus-5',
      codexModel: 'gpt-5.6-sol',
      claudePermissionMode: 'acceptEdits',
      codexPermissionMode: 'acceptEdits',
      longContextEnabled: true,
      reasoningEffort: 'xhigh',
      codexFastMode: 'fast',
    };
    localStorage.setItem('model-selection-state', JSON.stringify(saved));

    renderHook(() => useModelStatePersistence(makeOptions()));

    expect(JSON.parse(localStorage.getItem('model-selection-state') as string)).toEqual(saved);
  });

  it('restores a saved CLI provider instead of silently falling back to claude', () => {
    // Regression: the hydration allowlist was ['claude','codex'], so a saved
    // grok/kimi/opencode provider was dropped and syncToBackend then pushed
    // set_provider claude, clobbering the CLI session on restart.
    const setCurrentProvider = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'kimi',
      kimiModel: 'kimi-k3',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setCurrentProvider })));
    vi.advanceTimersByTime(200);

    expect(setCurrentProvider).toHaveBeenCalledWith('kimi');
    expect(bridgeEventsFor('set_provider')).toEqual([['set_provider', 'kimi']]);
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'kimi-k3']]);
  });

  it('migrates a stale sentinel grok model id to grok-4.6', () => {
    // Versions before the ACP model-id fix persisted the profile name 'grok';
    // the ACP CLI rejects it ("unknown model id"), so it must be upgraded.
    const setSelectedGrokModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'grok',
      grokModel: 'grok',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedGrokModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedGrokModel).toHaveBeenCalledWith('grok-4.6');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'grok-4.6']]);
  });

  it('honors a backend-supplied CLI provider via __INITIAL_TAB_PROVIDER__', () => {
    const setCurrentProvider = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = 'grok';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = 'grok-4.6';

    renderHook(() => useModelStatePersistence(makeOptions({ setCurrentProvider })));
    vi.advanceTimersByTime(200);

    expect(setCurrentProvider).toHaveBeenCalledWith('grok');
    expect(bridgeEventsFor('set_provider')).toEqual([['set_provider', 'grok']]);
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'grok-4.6']]);
  });

  it('persists CLI model and permission selections in the snapshot', () => {
    // The save effect deliberately skips the mount pass (it would still see the
    // pre-hydration props), so drive a real prop change before reading the snapshot.
    const { rerender } = renderHook(
      (props: { openCodePermissionMode: PermissionMode }) => useModelStatePersistence(makeOptions({
        currentProvider: 'opencode',
        selectedOpenCodeModel: 'openai/gpt-5',
        ...props,
      })),
      { initialProps: { openCodePermissionMode: 'default' as PermissionMode } },
    );
    act(() => rerender({ openCodePermissionMode: 'acceptEdits' as PermissionMode }));

    const saved = JSON.parse(localStorage.getItem('model-selection-state') ?? '{}');
    expect(saved.provider).toBe('opencode');
    expect(saved.openCodeModel).toBe('openai/gpt-5');
    expect(saved.openCodePermissionMode).toBe('acceptEdits');
  });
});

describe('useModelStatePersistence — codex dynamic catalog models', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__;
    delete (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__;
  });

  it('restores a saved codex model that only exists in the dynamic catalog', () => {
    // The codex model list is dynamic (config.toml `model` + model_catalog_json),
    // so a catalog-only id like kimi-k3 must survive restart instead of being
    // reset to CODEX_MODELS[0] before the catalog fetch lands.
    const setSelectedCodexModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexModel: 'kimi-k3',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedCodexModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedCodexModel).toHaveBeenCalledWith('kimi-k3');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'kimi-k3']]);
  });

  it('honors a backend-supplied dynamic codex model via __INITIAL_TAB_MODEL__', () => {
    const setSelectedCodexModel = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = 'codex';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = 'kimi-k3';

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedCodexModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedCodexModel).toHaveBeenCalledWith('kimi-k3');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'kimi-k3']]);
  });

  it('ignores an empty saved codex model and keeps the default', () => {
    const setSelectedCodexModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexModel: '   ',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedCodexModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedCodexModel).not.toHaveBeenCalled();
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
  });
});
