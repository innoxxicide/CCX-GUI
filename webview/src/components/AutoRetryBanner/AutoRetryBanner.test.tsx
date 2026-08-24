import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendBridgeEvent } from '../../utils/bridge';
import AutoRetryBanner from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

const mockSendBridgeEvent = vi.mocked(sendBridgeEvent);

function pushStatus(status: Record<string, unknown>) {
  act(() => {
    window.updateAutoRetryStatus?.(JSON.stringify(status));
  });
}

describe('AutoRetryBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.updateAutoRetryStatus;
  });

  it('asks for the current state on mount', () => {
    // The backend only pushes on change, so a webview that reloaded mid-run
    // would otherwise show no banner — and no way to stop the run.
    render(<AutoRetryBanner />);

    expect(mockSendBridgeEvent).toHaveBeenCalledWith('get_auto_retry_status');
  });

  it('renders nothing until a run is in progress', () => {
    const { container } = render(<AutoRetryBanner />);
    expect(container.firstChild).toBeNull();

    pushStatus({ engaged: false, attempt: 0, nextAttemptAt: 0 });
    expect(container.firstChild).toBeNull();
  });

  it('announces when the next attempt fires', () => {
    render(<AutoRetryBanner />);

    pushStatus({ engaged: true, attempt: 2, nextAttemptAt: Date.UTC(2026, 0, 1, 12, 0) });

    expect(screen.getByText(/chat\.autoRetry\.pendingAt/)).toBeTruthy();
    expect(screen.getByText(/"attempt":2/)).toBeTruthy();
  });

  it('reports a nudge still awaiting its answer', () => {
    // nextAttemptAt is 0 while one is in flight: there is no next attempt to
    // announce until this one's outcome is known.
    render(<AutoRetryBanner />);

    pushStatus({ engaged: true, attempt: 1, nextAttemptAt: 0 });

    expect(screen.getByText(/chat\.autoRetry\.inFlight/)).toBeTruthy();
  });

  it('stops the run and clears itself when the button is clicked', () => {
    const { container } = render(<AutoRetryBanner />);
    pushStatus({ engaged: true, attempt: 1, nextAttemptAt: 0 });

    fireEvent.click(screen.getByRole('button'));

    expect(mockSendBridgeEvent).toHaveBeenCalledWith('cancel_auto_retry');
    expect(container.firstChild).toBeNull();
  });

  it('ignores a malformed payload instead of throwing', () => {
    const { container } = render(<AutoRetryBanner />);

    act(() => {
      window.updateAutoRetryStatus?.('not json');
    });

    expect(container.firstChild).toBeNull();
  });

  it('restores the previous callback on unmount', () => {
    const previous = vi.fn();
    window.updateAutoRetryStatus = previous;

    const { unmount } = render(<AutoRetryBanner />);
    unmount();

    expect(window.updateAutoRetryStatus).toBe(previous);
  });
});
