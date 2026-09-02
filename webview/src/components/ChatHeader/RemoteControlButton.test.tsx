import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import RemoteControlButton from './RemoteControlButton';

const sendToJava = vi.fn();

vi.mock('../../utils/bridge', () => ({
  sendToJava: (message: string, payload: unknown) => sendToJava(message, payload),
}));

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as unknown as TFunction;

function answer(payload: Record<string, unknown>) {
  act(() => {
    window.onRemoteControlResult?.(JSON.stringify(payload));
  });
}

beforeEach(() => {
  sendToJava.mockClear();
  window.onRemoteControlResult = undefined;
});

it('asks the backend to hand over the session and lights up once it confirms', () => {
  render(<RemoteControlButton t={t} />);
  const button = screen.getByTestId('remote-control-button');
  expect(button.getAttribute('data-state')).toBe('off');

  fireEvent.click(button);
  expect(sendToJava).toHaveBeenCalledWith('set_remote_control', { enabled: true });
  expect(button.getAttribute('data-state'), 'the request is in flight, so a second click must not fire').toBe('pending');

  answer({ success: true, enabled: true });
  expect(button.getAttribute('data-state')).toBe('on');
});

it('asks for the session back on the next click', () => {
  render(<RemoteControlButton t={t} />);
  const button = screen.getByTestId('remote-control-button');

  fireEvent.click(button);
  answer({ success: true, enabled: true });

  fireEvent.click(button);
  expect(sendToJava).toHaveBeenLastCalledWith('set_remote_control', { enabled: false });

  answer({ success: true, enabled: false });
  expect(button.getAttribute('data-state')).toBe('off');
});

it('stays off on a refusal and shows the reason, instead of promising a session nobody can reach', () => {
  render(<RemoteControlButton t={t} />);
  const button = screen.getByTestId('remote-control-button');

  fireEvent.click(button);
  answer({ success: false, error: 'Remote Control is not yet enabled for your account' });

  expect(button.getAttribute('data-state')).toBe('off');
  expect(button.getAttribute('data-failed')).toBe('true');
  expect(button.getAttribute('data-tooltip')).toBe('Remote Control is not yet enabled for your account');
});

it('is absent for providers whose runtime has no such control request', () => {
  render(<RemoteControlButton t={t} provider="codex" />);
  expect(screen.queryByTestId('remote-control-button')).toBeNull();
});
