import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../../utils/bridge';
import styles from './style.module.less';

interface ScheduledSendStatus {
  scheduled: boolean;
  fireAt: number;
  preview: string;
  missed: boolean;
  /** Set only when a schedule request was rejected; the rest of the payload is unchanged state. */
  error: string | null;
}

/**
 * Status strip shown above the chat input while a "Send scheduled" delivery is
 * pending for this tab, and afterwards if it could not be delivered on time.
 *
 * Self-contained in the same way as {@code ClaudeAutoResumeBanner}: it registers
 * the {@code window.updateScheduledSendStatus} callback the Java backend pushes
 * to and renders straight from that payload. It does ask for the current state
 * once on mount, though — the backend only pushes on change, so a webview that
 * reloaded mid-schedule would otherwise show nothing until the send fired.
 */
const ScheduledSendBanner = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ScheduledSendStatus | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    const prev = window.updateScheduledSendStatus;
    window.updateScheduledSendStatus = (json: string) => {
      try {
        const parsed = JSON.parse(json) as Partial<ScheduledSendStatus>;
        setStatus({
          scheduled: parsed.scheduled === true,
          fireAt: typeof parsed.fireAt === 'number' ? parsed.fireAt : 0,
          preview: typeof parsed.preview === 'string' ? parsed.preview : '',
          missed: parsed.missed === true,
          error: typeof parsed.error === 'string' ? parsed.error : null,
        });
        setErrorCode(typeof parsed.error === 'string' ? parsed.error : null);
      } catch {
        /* ignore malformed payload */
      }
    };
    sendBridgeEvent('get_scheduled_send_status');
    return () => {
      window.updateScheduledSendStatus = prev;
    };
  }, []);

  const handleCancel = useCallback(() => {
    sendBridgeEvent('cancel_scheduled_send');
    // Optimistically clear; the backend pushes the disarmed status right after.
    setStatus(null);
    setErrorCode(null);
  }, []);

  const handleSendNow = useCallback(() => {
    sendBridgeEvent('send_scheduled_now');
    setStatus(null);
    setErrorCode(null);
  }, []);

  const handleDismissError = useCallback(() => {
    setErrorCode(null);
  }, []);

  const fireLabel = useMemo(() => {
    if (!status || status.fireAt <= 0) {
      return null;
    }
    try {
      const target = new Date(status.fireAt);
      const time = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // Same-day sends read better without a date in front of them.
      const isToday = new Date().toDateString() === target.toDateString();
      return isToday ? time : `${target.toLocaleDateString()} ${time}`;
    } catch {
      return null;
    }
  }, [status]);

  if (errorCode) {
    return (
      <div className={`${styles.banner} ${styles.error}`}>
        <span className="codicon codicon-warning" />
        <span className={styles.text}>
          {t(`scheduledSend.error.${errorCode}`, { defaultValue: t('scheduledSend.error.invalid') })}
        </span>
        <button type="button" className={styles.ghostBtn} onClick={handleDismissError}>
          {t('scheduledSend.dismiss')}
        </button>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  if (status.missed) {
    return (
      <div className={`${styles.banner} ${styles.missed}`}>
        <span className="codicon codicon-history" />
        <span className={styles.text}>{t('scheduledSend.missed')}</span>
        <button type="button" className={styles.primaryBtn} onClick={handleSendNow}>
          {t('scheduledSend.sendNow')}
        </button>
        <button type="button" className={styles.ghostBtn} onClick={handleCancel}>
          {t('scheduledSend.discard')}
        </button>
      </div>
    );
  }

  if (status.scheduled) {
    return (
      <div className={`${styles.banner} ${styles.pending}`}>
        <span className="codicon codicon-clock" />
        <span className={styles.text}>
          {fireLabel ? t('scheduledSend.pendingAt', { time: fireLabel }) : t('scheduledSend.pending')}
          {status.preview && <span className={styles.preview}>{status.preview}</span>}
        </span>
        <button type="button" className={styles.ghostBtn} onClick={handleCancel}>
          {t('scheduledSend.cancelPending')}
        </button>
      </div>
    );
  }

  return null;
};

export default ScheduledSendBanner;
