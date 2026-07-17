import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeLimitsState } from '../../types/usageLimits';
import { BatteryIndicator } from '../BatteryIndicator/BatteryIndicator';
import { formatResetHint } from '../BatteryIndicator/batteryUtils';

export interface ClaudeLimitsIndicatorsProps {
  limits: ClaudeLimitsState;
  onClick: () => void;
  t: TFunction;
}

/**
 * The clickable header block holding the two Claude battery gauges: the left
 * one tracks the 5-hour session window, the right one the 7-day (weekly)
 * window. Clicking anywhere on the block opens the usage-statistics modal.
 */
export const ClaudeLimitsIndicators = memo(function ClaudeLimitsIndicators({
  limits,
  onClick,
  t,
}: ClaudeLimitsIndicatorsProps) {
  const fiveHour = limits.usage?.five_hour;
  const sevenDay = limits.usage?.seven_day;
  if (!fiveHour && !sevenDay) {
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
