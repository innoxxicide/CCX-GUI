import { memo } from 'react';
import { batteryColor, remainingFromUtilization } from './batteryUtils';
import './BatteryIndicator.css';

export interface BatteryIndicatorProps {
  /** Percent of the window already consumed (0-100). */
  utilization: number;
  /** Short label rendered before the battery, e.g. "5h" / "7d". */
  label?: string;
  /** Native tooltip with the detailed used%/reset breakdown. */
  title?: string;
}

/**
 * Phone-style battery gauge: the fill and percentage show the *remaining*
 * budget for a rate-limit window (100 - utilization), coloured green/amber/red
 * and pulsing when nearly exhausted.
 */
export const BatteryIndicator = memo(function BatteryIndicator({
  utilization,
  label,
  title,
}: BatteryIndicatorProps) {
  const remaining = remainingFromUtilization(utilization);
  const color = batteryColor(remaining);
  const fillWidth = (18.5 * remaining) / 100;
  const low = remaining < 20;

  return (
    <span className={`battery-indicator${low ? ' battery-indicator--low' : ''}`} title={title}>
      {label ? <span className="battery-indicator__label">{label}</span> : null}
      <svg
        className="battery-indicator__svg"
        viewBox="0 0 28 14"
        width="28"
        height="14"
        aria-hidden="true"
        focusable="false"
      >
        <rect className="battery-indicator__body" x="1" y="2" width="22" height="10" rx="2.5" />
        <rect className="battery-indicator__cap" x="24" y="5" width="2.5" height="4" rx="1" />
        {fillWidth > 0 ? (
          <rect x="2.75" y="3.75" width={fillWidth} height="6.5" rx="1" style={{ fill: color }} />
        ) : null}
      </svg>
      <span className="battery-indicator__pct" style={{ color }}>
        {remaining}%
      </span>
    </span>
  );
});
