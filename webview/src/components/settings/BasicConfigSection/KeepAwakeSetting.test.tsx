import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';
import { KeepAwakeSetting } from './KeepAwakeSetting';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
  sendToJava: vi.fn(),
}));

const mockSendBridgeEvent = vi.mocked(sendBridgeEvent);
const mockSendToJava = vi.mocked(sendToJava);

describe('KeepAwakeSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.updateKeepAwakeEnabled;
  });

  it('asks the backend for the current value on mount', () => {
    render(<KeepAwakeSetting />);

    expect(mockSendBridgeEvent).toHaveBeenCalledWith('get_keep_awake_enabled');
  });

  it('renders off until the backend says otherwise', () => {
    // Default-off is the contract: never suppress sleep before the stored value
    // has arrived, or a slow config read would silently opt the user in.
    render(<KeepAwakeSetting />);

    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('sends the new value when toggled on', () => {
    render(<KeepAwakeSetting />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(mockSendToJava).toHaveBeenCalledWith('set_keep_awake_enabled', {
      keepAwakeWhileAgentWorksEnabled: true,
    });
  });

  it('adopts the value pushed by the backend', () => {
    render(<KeepAwakeSetting />);

    act(() => {
      window.updateKeepAwakeEnabled?.(JSON.stringify({ keepAwakeWhileAgentWorksEnabled: true }));
    });

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('ignores a malformed payload instead of throwing', () => {
    render(<KeepAwakeSetting />);

    act(() => {
      window.updateKeepAwakeEnabled?.('not json');
    });

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('restores the previous callback on unmount', () => {
    const previous = vi.fn();
    window.updateKeepAwakeEnabled = previous;

    const { unmount } = render(<KeepAwakeSetting />);
    unmount();

    expect(window.updateKeepAwakeEnabled).toBe(previous);
  });
});
