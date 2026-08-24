import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';
import { AutoRetrySetting } from './AutoRetrySetting';

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

const DEFAULT_PROMPT = 'Continue working on the task.';

describe('AutoRetrySetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.updateAutoRetryEnabled;
    delete window.updateAutoRetryPrompt;
  });

  it('asks the backend for both values on mount', () => {
    render(<AutoRetrySetting />);

    expect(mockSendBridgeEvent).toHaveBeenCalledWith('get_auto_retry_enabled');
    expect(mockSendBridgeEvent).toHaveBeenCalledWith('get_auto_retry_prompt');
  });

  it('renders off until the backend says otherwise', () => {
    // Default-off is the contract: never start sending messages on the user's
    // behalf before the stored value has arrived.
    render(<AutoRetrySetting />);

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('sends the new value when toggled on', () => {
    render(<AutoRetrySetting />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(mockSendToJava).toHaveBeenCalledWith('set_auto_retry_enabled', {
      autoRetryOnErrorEnabled: true,
    });
  });

  it('adopts the values pushed by the backend', () => {
    render(<AutoRetrySetting />);

    act(() => {
      window.updateAutoRetryEnabled?.(JSON.stringify({ autoRetryOnErrorEnabled: true }));
      window.updateAutoRetryPrompt?.(JSON.stringify({ autoRetryPrompt: 'Carry on.' }));
    });

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Carry on.');
  });

  it('commits an edited prompt on blur', () => {
    render(<AutoRetrySetting />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '  Keep going.  ' } });
    fireEvent.blur(textarea);

    expect(mockSendToJava).toHaveBeenCalledWith('set_auto_retry_prompt', {
      autoRetryPrompt: 'Keep going.',
    });
  });

  it('falls back to the default when the prompt is cleared', () => {
    // Mirrors the backend's normalization, so the field never claims the agent
    // will be sent an empty message.
    render(<AutoRetrySetting />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.blur(textarea);

    expect(mockSendToJava).toHaveBeenCalledWith('set_auto_retry_prompt', {
      autoRetryPrompt: DEFAULT_PROMPT,
    });
    expect((textarea as HTMLTextAreaElement).value).toBe(DEFAULT_PROMPT);
  });

  it('ignores malformed payloads instead of throwing', () => {
    render(<AutoRetrySetting />);

    act(() => {
      window.updateAutoRetryEnabled?.('not json');
      window.updateAutoRetryPrompt?.('not json');
    });

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(DEFAULT_PROMPT);
  });

  it('restores the previous callbacks on unmount', () => {
    const previousEnabled = vi.fn();
    const previousPrompt = vi.fn();
    window.updateAutoRetryEnabled = previousEnabled;
    window.updateAutoRetryPrompt = previousPrompt;

    const { unmount } = render(<AutoRetrySetting />);
    unmount();

    expect(window.updateAutoRetryEnabled).toBe(previousEnabled);
    expect(window.updateAutoRetryPrompt).toBe(previousPrompt);
  });
});
