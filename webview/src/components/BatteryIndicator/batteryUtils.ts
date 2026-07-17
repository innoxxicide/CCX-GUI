import type { TFunction } from 'i18next';

/** Clamp any number into the 0-100 percentage range. */
export function clampPercent(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Remaining budget (0-100) given a consumed-utilization percentage. */
export function remainingFromUtilization(utilization: number): number {
  return Math.round(clampPercent(100 - clampPercent(utilization)));
}

/**
 * Battery fill colour by remaining budget: green when plenty is left, amber
 * when getting low, red when nearly exhausted. Falls back to literal hex so the
 * colours render even if the CSS variables are absent.
 */
export function batteryColor(remaining: number): string {
  if (remaining > 50) return 'var(--color-success, #22c55e)';
  if (remaining >= 20) return 'var(--color-warning, #eab308)';
  return 'var(--color-danger, #ef4444)';
}

/** Human-readable "time until" an ISO8601 instant, e.g. "3d 4h", "2h 15m", "8m". */
export function formatTimeUntil(iso: string | null | undefined): string {
  if (!iso) return '';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return '';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Localised "resets in X" hint (or "resets soon" when the window has lapsed). */
export function formatResetHint(iso: string | null | undefined, t: TFunction): string {
  const rel = formatTimeUntil(iso);
  if (!rel) return t('usageLimits.resetsSoon', { defaultValue: 'resets soon' });
  return t('usageLimits.resetsIn', { time: rel, defaultValue: 'resets in {{time}}' });
}
