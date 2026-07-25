import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import type { ClaudeLimitsState } from '../../types/usageLimits';

export interface UseClaudeLimitsRefreshOptions {
  currentProvider: string;
  /** Active session id; changes whenever a session tab opens a new or existing session. */
  currentSessionId: string | null;
  setClaudeLimits: Dispatch<SetStateAction<ClaudeLimitsState | null>>;
  setUsageStatsModalOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * Asks the backend for a Claude usage-limits snapshot at the points where the
 * header battery indicators would otherwise keep showing whatever the last
 * agent turn left behind:
 *
 * - Claude becomes the active provider (covers mount, i.e. plugin start, a newly
 *   opened tab, and a tab restored on IDE startup).
 * - The session changes — opening an existing session from history, or starting
 *   a new one.
 * - The webview regains focus or visibility.
 *
 * The regular once-a-minute refresh and IDE-window activation are driven from
 * the backend (`ClaudeLimitsHandler`), which sees those events reliably; the
 * focus listener here is a complement for the case where the browser component
 * itself is what the user clicked back into. Every path lands on the same
 * TTL-guarded service, so extra requests cost at most a cached round trip.
 *
 * Switching away from Claude clears the data and closes the modal — only Claude
 * has these limits.
 */
export function useClaudeLimitsRefresh({
  currentProvider,
  currentSessionId,
  setClaudeLimits,
  setUsageStatsModalOpen,
}: UseClaudeLimitsRefreshOptions): void {
  useEffect(() => {
    if (currentProvider !== 'claude') {
      setClaudeLimits(null);
      setUsageStatsModalOpen(false);
      return;
    }
    sendBridgeEvent('get_claude_limits');
  }, [currentProvider, currentSessionId, setClaudeLimits, setUsageStatsModalOpen]);

  useEffect(() => {
    if (currentProvider !== 'claude') return;

    const request = () => {
      sendBridgeEvent('get_claude_limits');
    };
    const onVisibilityChange = () => {
      if (!document.hidden) request();
    };

    window.addEventListener('focus', request);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', request);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currentProvider]);
}
