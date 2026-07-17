import { memo, useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClaudeLimitsState, UsageBucket } from '../../types/usageLimits';
import { batteryColor, clampPercent, formatResetHint, remainingFromUtilization } from '../BatteryIndicator/batteryUtils';
import './UsageStatsModal.css';

export interface UsageStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  limits: ClaudeLimitsState | null;
  /** Force-refetch the limits (bypassing the backend TTL). */
  onRefresh: () => void;
}

interface RowDef {
  key: string;
  label: string;
  bucket: UsageBucket;
}

function UsageRow({ label, bucket, t }: { label: string; bucket: UsageBucket; t: TFunction }) {
  const used = Math.round(clampPercent(bucket.utilization));
  const remaining = remainingFromUtilization(bucket.utilization);
  const color = batteryColor(remaining);
  const reset = formatResetHint(bucket.resets_at, t);

  return (
    <div className="usage-stats-row">
      <div className="usage-stats-row-head">
        <span className="usage-stats-row-label">{label}</span>
        <span className="usage-stats-row-value">
          {t('usageLimits.percentUsed', { used, defaultValue: '{{used}}% used' })}
        </span>
      </div>
      <div className="usage-stats-bar">
        <div
          className="usage-stats-bar-fill"
          style={{ width: `${used}%`, backgroundColor: color }}
        />
      </div>
      {reset ? <div className="usage-stats-row-reset">{reset}</div> : null}
    </div>
  );
}

/**
 * The usage-statistics window opened from the header battery block. Lists every
 * rate-limit window the account exposes (5-hour session, weekly overall, and
 * per-model weekly), plus any pay-as-you-go extra usage, each as a labelled bar.
 * Mirrors the JCEF-friendly overlay conventions of ContextUsageDialog.
 */
export const UsageStatsModal = memo(function UsageStatsModal({
  isOpen,
  onClose,
  limits,
  onRefresh,
}: UsageStatsModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const rows = useMemo<RowDef[]>(() => {
    const usage = limits?.usage;
    if (!usage) return [];
    const defs: RowDef[] = [];
    if (usage.five_hour) {
      defs.push({ key: 'five_hour', label: t('usageLimits.sessionRow', { defaultValue: '5-hour session' }), bucket: usage.five_hour });
    }
    if (usage.seven_day) {
      defs.push({ key: 'seven_day', label: t('usageLimits.weeklyRow', { defaultValue: 'Weekly (all models)' }), bucket: usage.seven_day });
    }
    if (usage.seven_day_sonnet) {
      defs.push({ key: 'seven_day_sonnet', label: t('usageLimits.weeklySonnetRow', { defaultValue: 'Weekly · Sonnet' }), bucket: usage.seven_day_sonnet });
    }
    if (usage.seven_day_opus) {
      defs.push({ key: 'seven_day_opus', label: t('usageLimits.weeklyOpusRow', { defaultValue: 'Weekly · Opus' }), bucket: usage.seven_day_opus });
    }
    return defs;
  }, [limits, t]);

  const extraUsage = limits?.usage?.extra_usage;
  const showExtraUsage = !!extraUsage?.is_enabled && typeof extraUsage.utilization === 'number';

  const closeDialog = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleCloseMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeDialog();
  }, [closeDialog]);

  const handleDialogMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeDialog]);

  useEffect(() => {
    if (!isOpen) return undefined;
    lastFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const rafId = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(rafId);
      lastFocusedElementRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const available = !!limits?.available;
  const subscription = limits?.subscriptionType;
  const updatedAt = limits?.fetchedAt
    ? new Date(limits.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="usage-stats-overlay" onMouseDown={handleCloseMouseDown}>
      <div
        className="usage-stats-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={handleDialogMouseDown}
      >
        <div className="usage-stats-header">
          <h3 id={titleId} className="usage-stats-title">
            {t('usageLimits.title', { defaultValue: 'Usage limits' })}
            {available && subscription ? (
              <span className="usage-stats-plan">{subscription.toUpperCase()}</span>
            ) : null}
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="usage-stats-close"
            onMouseDown={handleCloseMouseDown}
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            ×
          </button>
        </div>

        <div className="usage-stats-body">
          {available && rows.length > 0 ? (
            <>
              {rows.map((row) => (
                <UsageRow key={row.key} label={row.label} bucket={row.bucket} t={t} />
              ))}
              {showExtraUsage ? (
                <div className="usage-stats-row">
                  <div className="usage-stats-row-head">
                    <span className="usage-stats-row-label">
                      {t('usageLimits.extraUsageRow', { defaultValue: 'Extra usage' })}
                    </span>
                    <span className="usage-stats-row-value">
                      {t('usageLimits.percentUsed', {
                        used: Math.round(clampPercent(extraUsage!.utilization ?? 0)),
                        defaultValue: '{{used}}% used',
                      })}
                    </span>
                  </div>
                  <div className="usage-stats-bar">
                    <div
                      className="usage-stats-bar-fill"
                      style={{
                        width: `${Math.round(clampPercent(extraUsage!.utilization ?? 0))}%`,
                        backgroundColor: batteryColor(
                          remainingFromUtilization(extraUsage!.utilization ?? 0),
                        ),
                      }}
                    />
                  </div>
                  {typeof extraUsage!.used_credits === 'number' && typeof extraUsage!.monthly_limit === 'number' ? (
                    <div className="usage-stats-row-reset">
                      {t('usageLimits.extraUsageCredits', {
                        used: extraUsage!.used_credits,
                        limit: extraUsage!.monthly_limit,
                        defaultValue: '{{used}} / {{limit}} credits',
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="usage-stats-empty">
              {t('usageLimits.unavailable', {
                defaultValue:
                  'Usage limits are only available when signed in to a Claude Pro or Max plan.',
              })}
            </div>
          )}
        </div>

        <div className="usage-stats-footer">
          <span className="usage-stats-updated">
            {updatedAt
              ? t('usageLimits.updatedAt', { time: updatedAt, defaultValue: 'Updated {{time}}' })
              : ''}
          </span>
          <button
            type="button"
            className="usage-stats-refresh"
            onMouseDown={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
          >
            {t('usageLimits.refresh', { defaultValue: 'Refresh' })}
          </button>
        </div>
      </div>
    </div>
  );
});
