import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeLimitsState } from '../../types/usageLimits';
import { BatteryIndicator } from '../BatteryIndicator/BatteryIndicator';
import { formatResetHint } from '../BatteryIndicator/batteryUtils';

export interface ClaudeLimitsIndicatorsProps {
  limits: ClaudeLimitsState | null;
  onClick: () => void;
  t: TFunction;
}

/**
 * The clickable header block holding the two Claude battery gauges: the left
 * one tracks the 5-hour session window, the right one the 7-day (weekly)
 * window. Clicking anywhere on the block opens the usage-statistics modal.
 *
 * When the account has no OAuth (Pro/Max) login the usage endpoint returns no
 * data (`reason: 'no_oauth'` — API-key / relay users). Rather than render an
 * unexplained void, a muted battery outline is shown so it's clear the gauges
 * need a subscription login; clicking it opens the modal that spells that out.
 */
export const ClaudeLimitsIndicators = memo(function ClaudeLimitsIndicators({
  limits,
  onClick,
  t,
}: ClaudeLimitsIndicatorsProps) {
  if (!limits) {
    return null;
  }

  const fiveHour = limits.available ? limits.usage?.five_hour : undefined;
  const sevenDay = limits.available ? limits.usage?.seven_day : undefined;
  if (!fiveHour && !sevenDay) {
    if (limits.reason === 'no_oauth') {
      const hint = t('usageLimits.noOauthHint', {
        defaultValue: 'Usage limits need a Claude Pro/Max login — click for details',
      });
      return (
        <button
          type="button"
          className="claude-limits-indicators claude-limits-indicators--hint"
          onClick={onClick}
          title={hint}
          aria-label={hint}
        >
          <svg viewBox="0 0 28 14" width="28" height="14" aria-hidden="true" focusable="false">
            <rect x="1" y="2" width="22" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="24" y="5" width="2.5" height="4" rx="1" fill="currentColor" />
          </svg>
        </button>
      );
    }
    return null;
  }

  const sessionTitle = fiveHour
    ? t('usageLimits.sessionTooltip', {
        used: Math.round(fiveHour.utilization),
        reset: formatResetHint(fiveHour.resets_at, t),
        defaultValue: '5-hour session: {{used}}% used · {{reset}}',
      })
    : undefined;
  const weeklyTitle = sevenDay
    ? t('usageLimits.weeklyTooltip', {
        used: Math.round(sevenDay.utilization),
        reset: formatResetHint(sevenDay.resets_at, t),
        defaultValue: 'Weekly limit: {{used}}% used · {{reset}}',
      })
    : undefined;

  return (
    <button
      type="button"
      className="claude-limits-indicators"
      onClick={onClick}
      aria-label={t('usageLimits.openStats', { defaultValue: 'Open usage statistics' })}
    >
      {fiveHour ? (
        <BatteryIndicator
          label={t('usageLimits.sessionShort', { defaultValue: '5h' })}
          utilization={fiveHour.utilization}
          title={sessionTitle}
        />
      ) : null}
      {sevenDay ? (
        <BatteryIndicator
          label={t('usageLimits.weeklyShort', { defaultValue: '7d' })}
          utilization={sevenDay.utilization}
          title={weeklyTitle}
        />
      ) : null}
    </button>
  );
});
