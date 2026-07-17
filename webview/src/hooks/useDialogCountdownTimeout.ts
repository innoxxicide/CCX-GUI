import { useCallback, useEffect, useRef, useState } from 'react';

const WARNING_THRESHOLD_SECONDS = 30;

interface UseDialogCountdownTimeoutOptions {
  isOpen: boolean;
  requestKey?: string | null;
  timeoutSeconds: number;
  onTimeout: () => void;
  /**
   * When false, the dialog waits indefinitely: no countdown runs, {@link onTimeout} never fires,
   * and {@link markSubmitted} always succeeds. Defaults to true (auto-close on timeout).
   */
  enabled?: boolean;
}

interface UseDialogCountdownTimeoutReturn {
  remainingSeconds: number;
  isTimeWarning: boolean;
  isTimedOut: boolean;
  markSubmitted: () => boolean;
  /** Whether the countdown is active — dialogs hide the timer UI when this is false. */
  countdownEnabled: boolean;
}

export function useDialogCountdownTimeout({
  isOpen,
  requestKey,
  timeoutSeconds,
  onTimeout,
  enabled = true,
}: UseDialogCountdownTimeoutOptions): UseDialogCountdownTimeoutReturn {
  const [remainingSeconds, setRemainingSeconds] = useState(timeoutSeconds);
  const remainingSecondsRef = useRef(timeoutSeconds);
  const deadlineMsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const submittedRef = useRef(false);
  const expiredRef = useRef(false);
  const timeoutFiredRef = useRef(false);

  // Capture the latest timeoutSeconds so the open effect can read it without
  // adding timeoutSeconds to its dependency list.
  const capturedTimeoutRef = useRef(timeoutSeconds);
  capturedTimeoutRef.current = timeoutSeconds;

  // Capture `enabled` the same way. The value is read when the dialog opens; toggling the
  // setting while a dialog is already open does not change that dialog's countdown behaviour.
  const capturedEnabledRef = useRef(enabled);
  capturedEnabledRef.current = enabled;

  const triggerTimeout = useCallback(() => {
    expiredRef.current = true;
    if (submittedRef.current || timeoutFiredRef.current) {
      return;
    }
    timeoutFiredRef.current = true;
    submittedRef.current = true;
    onTimeout();
  }, [onTimeout]);

  const markSubmitted = useCallback(() => {
    if (submittedRef.current || expiredRef.current) {
      return false;
    }
    if (Date.now() >= deadlineMsRef.current) {
      // setInterval tick can be deferred by event loop pressure or tab throttling,
      // so the wall-clock deadline is the authoritative gate on user submissions.
      triggerTimeout();
      return false;
    }
    submittedRef.current = true;
    return true;
  }, [triggerTimeout]);

  useEffect(() => {
    if (isOpen && requestKey) {
      const effectiveTimeout = capturedTimeoutRef.current;
      const effectiveEnabled = capturedEnabledRef.current;
      submittedRef.current = false;
      expiredRef.current = false;
      timeoutFiredRef.current = false;
      remainingSecondsRef.current = effectiveTimeout;
      setRemainingSeconds(effectiveTimeout);
      // An infinite deadline keeps markSubmitted() permissive forever, so a submission is never
      // rejected as "too late" while the user takes their time.
      deadlineMsRef.current = effectiveEnabled
        ? Date.now() + effectiveTimeout * 1000
        : Number.POSITIVE_INFINITY;
    }
  }, [isOpen, requestKey]);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!isOpen || !requestKey || !capturedEnabledRef.current) {
      clearTimer();
      return;
    }

    clearTimer();
    timerRef.current = setInterval(() => {
      const nextRemainingSeconds = Math.max(
        0,
        Math.ceil((deadlineMsRef.current - Date.now()) / 1000),
      );
      remainingSecondsRef.current = nextRemainingSeconds;
      setRemainingSeconds(nextRemainingSeconds);
      if (nextRemainingSeconds === 0) {
        clearTimer();
        triggerTimeout();
      }
    }, 1000);

    return clearTimer;
  }, [isOpen, requestKey, triggerTimeout]);

  // When the countdown is disabled the dialog waits indefinitely, so there is no "answer soon"
  // warning and no timed-out state — even if timeoutSeconds happens to be at/below the warning
  // threshold (e.g. 30s), which would otherwise flag remainingSeconds as a warning immediately.
  const isTimeWarning = enabled && remainingSeconds <= WARNING_THRESHOLD_SECONDS && remainingSeconds > 0;
  const isTimedOut = enabled && remainingSeconds <= 0;

  return {
    remainingSeconds,
    isTimeWarning,
    isTimedOut,
    markSubmitted,
    countdownEnabled: enabled,
  };
}
