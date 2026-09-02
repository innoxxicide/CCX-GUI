import { act, renderHook } from '@testing-library/react';
import { useShiftHeld } from './useShiftHeld.js';

function press(type: 'keydown' | 'keyup', key: string, shiftKey = false) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key, shiftKey }));
  });
}

function moveMouse(shiftKey: boolean) {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { shiftKey }));
  });
}

describe('useShiftHeld', () => {
  it('follows the key while it is enabled', () => {
    const { result } = renderHook(() => useShiftHeld(true));

    expect(result.current).toBe(false);
    press('keydown', 'Shift');
    expect(result.current).toBe(true);
    press('keyup', 'Shift');
    expect(result.current).toBe(false);
  });

  it('ignores every other key, so typing a capital letter arms nothing', () => {
    const { result } = renderHook(() => useShiftHeld(true));

    press('keydown', 'A');
    expect(result.current).toBe(false);
  });

  it('arms on a mouse move made with Shift down, where no key press ever reached the page', () => {
    const { result } = renderHook(() => useShiftHeld(true));

    moveMouse(true);
    expect(result.current, 'the panel does not own the keyboard, so the pointer is the only witness').toBe(true);

    moveMouse(false);
    expect(result.current).toBe(false);
  });

  it('stays armed when one Shift is released while the other is still down', () => {
    const { result } = renderHook(() => useShiftHeld(true));

    press('keydown', 'Shift', true);
    press('keyup', 'Shift', true);
    expect(result.current).toBe(true);

    press('keyup', 'Shift', false);
    expect(result.current).toBe(false);
  });

  it('drops the key when the window loses focus, where the release never arrives', () => {
    const { result } = renderHook(() => useShiftHeld(true));

    press('keydown', 'Shift');
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current).toBe(false);
  });

  it('reports nothing held once it is switched off mid-press', () => {
    const { result, rerender } = renderHook(({ on }) => useShiftHeld(on), {
      initialProps: { on: true },
    });

    press('keydown', 'Shift');
    expect(result.current).toBe(true);

    rerender({ on: false });
    expect(result.current, 'a turn that ended cannot leave a send armed').toBe(false);

    press('keydown', 'Shift');
    expect(result.current).toBe(false);
  });
});
