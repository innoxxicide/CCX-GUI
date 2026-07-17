import { describe, expect, it } from 'vitest';
import {
  batteryColor,
  clampPercent,
  formatTimeUntil,
  remainingFromUtilization,
} from './batteryUtils';

describe('clampPercent', () => {
  it('clamps into the 0-100 range', () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42)).toBe(42);
  });

  it('treats NaN as 0', () => {
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('remainingFromUtilization', () => {
  it('returns the inverse budget, rounded', () => {
    expect(remainingFromUtilization(0)).toBe(100);
    expect(remainingFromUtilization(100)).toBe(0);
    expect(remainingFromUtilization(37.4)).toBe(63);
  });

  it('clamps out-of-range utilization', () => {
    expect(remainingFromUtilization(-5)).toBe(100);
    expect(remainingFromUtilization(120)).toBe(0);
  });
});

describe('batteryColor', () => {
  it('is green above 50% remaining', () => {
    expect(batteryColor(80)).toContain('#22c55e');
  });

  it('is amber between 20% and 50% remaining', () => {
    expect(batteryColor(35)).toContain('#eab308');
    expect(batteryColor(20)).toContain('#eab308');
  });

  it('is red below 20% remaining', () => {
    expect(batteryColor(10)).toContain('#ef4444');
  });
});

describe('formatTimeUntil', () => {
  it('returns empty for missing or past instants', () => {
    expect(formatTimeUntil(null)).toBe('');
    expect(formatTimeUntil(undefined)).toBe('');
    expect(formatTimeUntil('not-a-date')).toBe('');
    expect(formatTimeUntil(new Date(Date.now() - 60_000).toISOString())).toBe('');
  });

  it('formats days + hours when more than a day out', () => {
    const future = new Date(Date.now() + (2 * 24 * 60 + 3 * 60) * 60_000).toISOString();
    expect(formatTimeUntil(future)).toBe('2d 3h');
  });

  it('formats hours + minutes within a day', () => {
    const future = new Date(Date.now() + (2 * 60 + 15) * 60_000 + 5_000).toISOString();
    expect(formatTimeUntil(future)).toBe('2h 15m');
  });

  it('formats minutes only within the hour', () => {
    const future = new Date(Date.now() + 8 * 60_000 + 5_000).toISOString();
    expect(formatTimeUntil(future)).toBe('8m');
  });
});
