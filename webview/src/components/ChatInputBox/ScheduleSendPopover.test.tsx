import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScheduleSendPopover,
  parseScheduleInputs,
  toDateInputValue,
  toTimeInputValue,
  validateScheduleTarget,
} from './ScheduleSendPopover';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

describe('parseScheduleInputs', () => {
  it('reads the two native input values as a local-time instant', () => {
    const parsed = parseScheduleInputs('2026-08-17', '14:30');
    expect(parsed).not.toBeNull();

    const asDate = new Date(parsed as number);
    expect(asDate.getFullYear()).toBe(2026);
    expect(asDate.getMonth()).toBe(7); // August
    expect(asDate.getDate()).toBe(17);
    expect(asDate.getHours()).toBe(14);
    expect(asDate.getMinutes()).toBe(30);
    expect(asDate.getSeconds()).toBe(0);
  });

  it('rejects empty or malformed values rather than guessing', () => {
    expect(parseScheduleInputs('', '14:30')).toBeNull();
    expect(parseScheduleInputs('2026-08-17', '')).toBeNull();
    expect(parseScheduleInputs('17/08/2026', '14:30')).toBeNull();
    expect(parseScheduleInputs('2026-08-17', '2:30 PM')).toBeNull();
  });

  it('round-trips a date through the input formatters without a UTC shift', () => {
    const source = new Date(2026, 0, 1, 0, 5, 0, 0);
    const parsed = parseScheduleInputs(toDateInputValue(source), toTimeInputValue(source));
    expect(parsed).toBe(source.getTime());
  });
});

describe('validateScheduleTarget', () => {
  const now = 1_000_000_000_000;

  it('accepts a future time inside the lead limit', () => {
    expect(validateScheduleTarget(now + 60_000, now)).toBeNull();
    expect(validateScheduleTarget(now + MAX_LEAD_MS, now)).toBeNull();
  });

  it('rejects an unparsable target', () => {
    expect(validateScheduleTarget(null, now)).toBe('invalid');
  });

  it('rejects the present and the past', () => {
    expect(validateScheduleTarget(now, now)).toBe('past');
    expect(validateScheduleTarget(now - 1, now)).toBe('past');
  });

  it('rejects a target beyond the lead limit', () => {
    expect(validateScheduleTarget(now + MAX_LEAD_MS + 1, now)).toBe('tooFarAhead');
  });
});

describe('ScheduleSendPopover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 17, 14, 30, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on the current date and time', () => {
    render(<ScheduleSendPopover onSchedule={vi.fn()} onClose={vi.fn()} />);

    expect((screen.getByLabelText('scheduledSend.dateLabel') as HTMLInputElement).value).toBe('2026-08-17');
    expect((screen.getByLabelText('scheduledSend.timeLabel') as HTMLInputElement).value).toBe('14:30');
  });

  it('schedules the chosen instant', () => {
    const onSchedule = vi.fn();
    render(<ScheduleSendPopover onSchedule={onSchedule} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('scheduledSend.timeLabel'), { target: { value: '18:45' } });
    fireEvent.click(screen.getByText('scheduledSend.schedule'));

    expect(onSchedule).toHaveBeenCalledWith(new Date(2026, 7, 17, 18, 45, 0, 0).getTime());
  });

  it('reports a past time inline instead of scheduling it', () => {
    const onSchedule = vi.fn();
    render(<ScheduleSendPopover onSchedule={onSchedule} onClose={vi.fn()} />);

    // The default value is the current minute, which has already begun.
    fireEvent.click(screen.getByText('scheduledSend.schedule'));

    expect(onSchedule).not.toHaveBeenCalled();
    expect(screen.getByText('scheduledSend.error.past')).toBeTruthy();
  });

  it('clears the error once the user edits a field', () => {
    render(<ScheduleSendPopover onSchedule={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('scheduledSend.schedule'));
    expect(screen.getByText('scheduledSend.error.past')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('scheduledSend.timeLabel'), { target: { value: '18:45' } });
    expect(screen.queryByText('scheduledSend.error.past')).toBeNull();
  });

  it('closes on Cancel and on Escape', () => {
    const onClose = vi.fn();
    const { unmount } = render(<ScheduleSendPopover onSchedule={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('scheduledSend.cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const onCloseAgain = vi.fn();
    render(<ScheduleSendPopover onSchedule={vi.fn()} onClose={onCloseAgain} />);
    fireEvent.keyDown(screen.getByText('scheduledSend.dialogTitle'), { key: 'Escape' });
    expect(onCloseAgain).toHaveBeenCalledTimes(1);
  });
});
