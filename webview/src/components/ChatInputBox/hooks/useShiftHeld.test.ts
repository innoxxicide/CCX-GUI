import { act, renderHook } from '@testing-library/react';
import { useShiftHeld } from './useShiftHeld.js';

function press(type: 'keydown' | 'keyup', key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key }));
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
