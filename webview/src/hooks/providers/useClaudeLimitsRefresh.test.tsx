import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClaudeLimitsRefresh } from './useClaudeLimitsRefresh.js';

const sendToJava = vi.fn();

const renderRefresh = (
  initial: { currentProvider: string; currentSessionId: string | null },
  overrides: {
    setClaudeLimits?: ReturnType<typeof vi.fn>;
    setUsageStatsModalOpen?: ReturnType<typeof vi.fn>;
  } = {},
) => {
  const setClaudeLimits = overrides.setClaudeLimits ?? vi.fn();
  const setUsageStatsModalOpen = overrides.setUsageStatsModalOpen ?? vi.fn();
  const view = renderHook(
    (props: { currentProvider: string; currentSessionId: string | null }) =>
      useClaudeLimitsRefresh({
        ...props,
        setClaudeLimits,
        setUsageStatsModalOpen,
      }),
    { initialProps: initial },
  );
  return { ...view, setClaudeLimits, setUsageStatsModalOpen };
};

const limitsRequests = () =>
  sendToJava.mock.calls.filter(([payload]) => String(payload).startsWith('get_claude_limits:'));

describe('useClaudeLimitsRefresh', () => {
  beforeEach(() => {
    sendToJava.mockClear();
    window.sendToJava = sendToJava;
  });

  afterEach(() => {
    delete window.sendToJava;
  });

  it('requests a snapshot on mount when Claude is the active provider', () => {
    renderRefresh({ currentProvider: 'claude', currentSessionId: null });

    expect(limitsRequests()).toHaveLength(1);
  });

  it('requests a snapshot again when the session changes', () => {
    const { rerender } = renderRefresh({ currentProvider: 'claude', currentSessionId: null });
    expect(limitsRequests()).toHaveLength(1);

    rerender({ currentProvider: 'claude', currentSessionId: 'session-a' });
    expect(limitsRequests()).toHaveLength(2);

    rerender({ currentProvider: 'claude', currentSessionId: 'session-b' });
    expect(limitsRequests()).toHaveLength(3);
  });

  it('does not re-request when nothing relevant changed', () => {
    const { rerender } = renderRefresh({ currentProvider: 'claude', currentSessionId: 'session-a' });
    expect(limitsRequests()).toHaveLength(1);

    rerender({ currentProvider: 'claude', currentSessionId: 'session-a' });
    expect(limitsRequests()).toHaveLength(1);
  });

  it('requests a snapshot when the window regains focus', () => {
    renderRefresh({ currentProvider: 'claude', currentSessionId: 'session-a' });
    expect(limitsRequests()).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(limitsRequests()).toHaveLength(2);
  });

  it('requests a snapshot when the page becomes visible again', () => {
    renderRefresh({ currentProvider: 'claude', currentSessionId: 'session-a' });
    expect(limitsRequests()).toHaveLength(1);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(limitsRequests()).toHaveLength(1);

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(limitsRequests()).toHaveLength(2);

    hidden.mockRestore();
  });

  it('clears the indicators and closes the modal for non-Claude providers', () => {
    const { setClaudeLimits, setUsageStatsModalOpen } = renderRefresh({
      currentProvider: 'codex',
      currentSessionId: 'session-a',
    });

    expect(limitsRequests()).toHaveLength(0);
    expect(setClaudeLimits).toHaveBeenCalledWith(null);
    expect(setUsageStatsModalOpen).toHaveBeenCalledWith(false);
  });

  it('stops listening for focus once Claude is no longer active', () => {
    const { rerender } = renderRefresh({ currentProvider: 'claude', currentSessionId: 'session-a' });
    sendToJava.mockClear();

    rerender({ currentProvider: 'codex', currentSessionId: 'session-a' });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(limitsRequests()).toHaveLength(0);
  });
});
