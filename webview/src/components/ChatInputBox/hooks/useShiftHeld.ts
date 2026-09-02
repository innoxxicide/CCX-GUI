import { useEffect, useState } from 'react';

/**
 * Whether Shift is being held right now, so a button can show what the next click
 * or Enter will actually do.
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
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setHeld(false);
    };
    const clear = () => setHeld(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
    };
  }, [enabled]);

  return held;
}
