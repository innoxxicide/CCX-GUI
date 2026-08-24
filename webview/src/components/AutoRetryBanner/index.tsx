import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../../utils/bridge';
import styles from './style.module.less';

interface AutoRetryStatus {
  engaged: boolean;
  attempt: number;
  /** When the next nudge fires; 0 while one is in flight and its outcome unknown. */
  nextAttemptAt: number;
}

/**
 * Status strip shown above the chat input while the agent is being nudged back
 * to work after an error, with the button that stops the run.
 *
 * <p>Self-contained in the same way as {@code ClaudeAutoResumeBanner}: it
 * registers the {@code window.updateAutoRetryStatus} callback the Java backend
 * pushes to and renders straight from that payload, so it needs nothing from the
 * App state tree. It also asks for the current state on mount, because the
 * backend only pushes on change — a webview that reloaded mid-run would
 * otherwise show nothing, leaving no way to stop it.
 */
const AutoRetryBanner = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AutoRetryStatus | null>(null);

  useEffect(() => {
    const previous = window.updateAutoRetryStatus;
    window.updateAutoRetryStatus = (json: string) => {
      try {
        const parsed = JSON.parse(json) as Partial<AutoRetryStatus>;
        setStatus({
          engaged: parsed.engaged === true,
          attempt: typeof parsed.attempt === 'number' ? parsed.attempt : 0,
          nextAttemptAt: typeof parsed.nextAttemptAt === 'number' ? parsed.nextAttemptAt : 0,
        });
      } catch {
        /* ignore malformed payload */
      }
    };

    sendBridgeEvent('get_auto_retry_status');

    return () => {
      window.updateAutoRetryStatus = previous;
    };
  }, []);

  const handleStop = useCallback(() => {
    sendBridgeEvent('cancel_auto_retry');
    // Optimistically clear; the backend disengages and pushes the cleared status
    // right after, so this only removes the flicker.
    setStatus(null);
  }, []);

  const nextLabel = useMemo(() => {
    if (!status || status.nextAttemptAt <= 0) {
      return null;
    }
    try {
      return new Date(status.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  }, [status]);

  if (!status || !status.engaged) {
    return null;
  }

  return (
    <div className={styles.banner}>
      <span className="codicon codicon-debug-restart" />
      <span className={styles.text}>
        {nextLabel
          ? t('chat.autoRetry.pendingAt', { attempt: status.attempt, time: nextLabel })
          : t('chat.autoRetry.inFlight', { attempt: status.attempt })}
      </span>
      <button type="button" className={styles.stopBtn} onClick={handleStop}>
        {t('chat.autoRetry.stop')}
      </button>
    </div>
  );
};

export default AutoRetryBanner;
