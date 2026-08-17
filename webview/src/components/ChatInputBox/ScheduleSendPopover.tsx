import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Longest a send may be scheduled ahead — mirrors ScheduledSendController.MAX_LEAD_MS. */
const MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Local-time `YYYY-MM-DD` / `HH:mm` strings for the native inputs. Deliberately
 * not `toISOString()`, which converts to UTC and would show the wrong day for
 * anyone east or west of Greenwich.
 */
export const toDateInputValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const toTimeInputValue = (date: Date) =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/**
 * Parse the two native input values back into epoch millis, interpreted in the
 * user's local timezone. Returns `null` when either field is empty or malformed,
 * so a half-filled form can never be scheduled.
 */
export const parseScheduleInputs = (dateValue: string, timeValue: string): number | null => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const parsed = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0
  );
  const millis = parsed.getTime();
  return Number.isNaN(millis) ? null : millis;
};

export type ScheduleValidationError = 'invalid' | 'past' | 'tooFarAhead' | null;

/**
 * Same rules the backend enforces, checked here so the user gets the reason
 * inline instead of a round-trip and a toast. The backend still re-validates:
 * this side cannot be trusted with the schedule, only with the explanation.
 */
export const validateScheduleTarget = (target: number | null, now: number): ScheduleValidationError => {
  if (target === null) {
    return 'invalid';
  }
  if (target <= now) {
    return 'past';
  }
  if (target - now > MAX_LEAD_MS) {
    return 'tooFarAhead';
  }
  return null;
};

interface ScheduleSendPopoverProps {
  /** Called with the chosen epoch millis when the user confirms. */
  onSchedule: (fireAtMs: number) => void;
  /** Called on Cancel, Escape, or an outside click. */
  onClose: () => void;
}

/**
 * Small date/time picker anchored above the "Send scheduled" button.
 *
 * Opens on the current date and time, as a starting point to adjust rather than
 * a submittable value — the current minute has by definition already begun, so
 * confirming without changing anything reports "pick a future time" instead of
 * silently rounding the target somewhere the user did not ask for.
 */
export const ScheduleSendPopover = ({ onSchedule, onClose }: ScheduleSendPopoverProps) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // Read the clock once, on mount, so the fields do not drift while the popover
  // is open and the user is mid-edit.
  const [dateValue, setDateValue] = useState(() => toDateInputValue(new Date()));
  const [timeValue, setTimeValue] = useState(() => toTimeInputValue(new Date()));
  const [error, setError] = useState<ScheduleValidationError>(null);

  const minDate = useMemo(() => toDateInputValue(new Date()), []);

  useEffect(() => {
    dateInputRef.current?.focus();
  }, []);

  // Close on outside click. The listener is attached on the next tick so the
  // click that opened the popover does not immediately close it again.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = window.setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const handleConfirm = useCallback(() => {
    const target = parseScheduleInputs(dateValue, timeValue);
    const validationError = validateScheduleTarget(target, Date.now());
    if (validationError !== null || target === null) {
      setError(validationError ?? 'invalid');
      return;
    }
    setError(null);
    onSchedule(target);
  }, [dateValue, timeValue, onSchedule]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // The popover lives inside the input box, whose own key handling would
      // otherwise see these and submit or navigate completions.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm, onClose]
  );

  return (
    <div
      ref={containerRef}
      className="schedule-send-popover"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <div className="schedule-send-title">{t('scheduledSend.dialogTitle')}</div>

      <div className="schedule-send-fields">
        <label className="schedule-send-field">
          <span className="schedule-send-label">{t('scheduledSend.dateLabel')}</span>
          <input
            ref={dateInputRef}
            type="date"
            className="schedule-send-input"
            value={dateValue}
            min={minDate}
            onChange={(e) => {
              setDateValue(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="schedule-send-field">
          <span className="schedule-send-label">{t('scheduledSend.timeLabel')}</span>
          <input
            type="time"
            className="schedule-send-input"
            value={timeValue}
            onChange={(e) => {
              setTimeValue(e.target.value);
              setError(null);
            }}
          />
        </label>
      </div>

      {error && <div className="schedule-send-error">{t(`scheduledSend.error.${error}`)}</div>}

      <div className="schedule-send-actions">
        <button type="button" className="schedule-send-btn schedule-send-btn-cancel" onClick={onClose}>
          {t('scheduledSend.cancel')}
        </button>
        <button type="button" className="schedule-send-btn schedule-send-btn-confirm" onClick={handleConfirm}>
          {t('scheduledSend.schedule')}
        </button>
      </div>
    </div>
  );
};

export default ScheduleSendPopover;
