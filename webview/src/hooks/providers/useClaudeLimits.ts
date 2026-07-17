import { useState } from 'react';
import type { ClaudeLimitsState } from '../../types/usageLimits';

/**
 * Holds the signed-in Claude account's usage-limit state (5-hour session +
 * weekly windows) shown in the header battery indicators. Populated by the
 * `onClaudeLimitsUpdate` window callback; null until the first push arrives.
 */
export function useClaudeLimits() {
  const [claudeLimits, setClaudeLimits] = useState<ClaudeLimitsState | null>(null);
  return { claudeLimits, setClaudeLimits };
}

export type UseClaudeLimitsReturn = ReturnType<typeof useClaudeLimits>;
