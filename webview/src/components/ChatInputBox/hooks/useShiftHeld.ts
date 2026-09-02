import { useEffect, useState } from 'react';

/**
 * Whether Shift is being held right now, so a button can show what the next click
 * or Enter will actually do.
 *
 * Pointer moves carry the modifier too, and they are what makes this work at all
 * inside the IDE: a key press only reaches the page while the chat panel owns the
 * keyboard focus, so a reader whose caret is still in the code editor presses Shift
 * and sees nothing. Moving the mouse over the panel needs no focus.
 *
 * Only listens while `enabled`, because the state re-renders its owner on every
 * Shift press, and outside a running turn there is nothing for it to arm.
 *
 * blur clears it: releasing Shift while another window has focus never reaches us,
 * and a stuck flag would leave the input claiming an intent the reader dropped.
 */
export function useShiftHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setHeld(true);
    };
    // Not `key === 'Shift'`: the release of one Shift while the other stays down is
    // still a held modifier, and shiftKey is the only field that knows it.
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.shiftKey) setHeld(false);
    };
    const onMouseMove = (event: MouseEvent) => setHeld(event.shiftKey);
    const clear = () => setHeld(false);

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('blur', clear);
    };
  }, [enabled]);

  return held;
}
