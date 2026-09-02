import { act, fireEvent, render, screen } from '@testing-library/react';
import { ButtonArea } from './ButtonArea';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../hooks/providers/useCliModels', () => ({
  useCliModels: () => ({
    cliModels: [],
    cliModelsLoading: false,
    cliModelsError: null,
    cliDefaultModel: null,
    cliCatalogHasEntries: false,
    refreshCliModels: vi.fn(),
  }),
}));

vi.mock('./selectors', () => ({
  CodexFastModeSelect: () => null,
  ConfigSelect: () => null,
  ModelSelect: () => null,
  ModeSelect: () => null,
  ProviderSelect: () => null,
  ReasoningSelect: () => null,
}));

function holdShift(down: boolean) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: 'Shift' }));
  });
}

function renderWorkingTurn(overrides?: { onStop?: () => void; onSendNow?: () => void; hasInputContent?: boolean }) {
  return render(
    <ButtonArea
      isLoading
      hasInputContent={overrides?.hasInputContent ?? true}
      onStop={overrides?.onStop}
      onSendNow={overrides?.onSendNow}
    />,
  );
}

describe('ButtonArea with nothing running', () => {
  it('lights the send button on Shift, so the key answers in this state too', () => {
    render(<ButtonArea hasInputContent />);

    const send = screen.getByTestId('send-button');
    expect(send.getAttribute('data-armed')).toBe('false');

    holdShift(true);
    expect(send.getAttribute('data-armed')).toBe('true');

    holdShift(false);
    expect(send.getAttribute('data-armed')).toBe('false');
  });

  it('stays dark with an empty input, where the button sends nothing', () => {
    render(<ButtonArea hasInputContent={false} />);

    holdShift(true);
    expect(screen.getByTestId('send-button').getAttribute('data-armed')).toBe('false');
  });
});

describe('ButtonArea while a turn is running', () => {
  it('arms both buttons on Shift and disarms them on release', () => {
    renderWorkingTurn();

    const sendNow = screen.getByTestId('send-now-button');
    const stop = screen.getByTestId('stop-button');
    expect(sendNow.getAttribute('data-armed')).toBe('false');
    expect(stop.getAttribute('data-armed')).toBe('false');

    holdShift(true);
    expect(sendNow.getAttribute('data-armed')).toBe('true');
    expect(stop.getAttribute('data-armed'), 'the button the hand is already on must show what it now does').toBe('true');
    expect(stop.querySelector('.codicon-debug-continue')).not.toBeNull();
    expect(stop.querySelector('.codicon-debug-stop'), 'a stop icon would promise a stop').toBeNull();

    holdShift(false);
    expect(sendNow.getAttribute('data-armed')).toBe('false');
    expect(stop.querySelector('.codicon-debug-stop')).not.toBeNull();
  });

  it('arms while the mouse travels to the button with Shift down and no keyboard focus', () => {
    renderWorkingTurn();

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true }));
    });
    expect(screen.getByTestId('send-now-button').getAttribute('data-armed')).toBe('true');
  });

  it('sends out of turn on a Shift-click of the stop button, and stops without it', () => {
    const onStop = vi.fn();
    const onSendNow = vi.fn();
    renderWorkingTurn({ onStop, onSendNow });

    const stop = screen.getByTestId('stop-button');
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSendNow).not.toHaveBeenCalled();

    holdShift(true);
    fireEvent.click(stop);
    expect(onSendNow).toHaveBeenCalledTimes(1);
    expect(onStop, 'the armed click replaces the stop, it does not add to it').toHaveBeenCalledTimes(1);
  });

  it('stays unarmed with an empty input, where there is nothing to send ahead', () => {
    const onStop = vi.fn();
    const onSendNow = vi.fn();
    renderWorkingTurn({ onStop, onSendNow, hasInputContent: false });

    holdShift(true);
    const stop = screen.getByTestId('stop-button');
    expect(stop.getAttribute('data-armed')).toBe('false');

    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSendNow).not.toHaveBeenCalled();
  });
});
