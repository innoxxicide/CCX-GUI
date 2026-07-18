import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../../utils/bridge';
import styles from './style.module.less';

interface AutoResumeStatus {
  armed: boolean;
  wakeAt: number;
  manualResumeNeeded: boolean;
  windows: string[];
}

/**
 * Claude-only status strip shown above the chat input while auto-resume is
 * active for this session. Self-contained: it registers the
 * {@code window.updateClaudeAutoResumeStatus} callback the Java backend pushes
 * to and renders directly from that payload, so it needs no props from the App
 * state tree. Renders nothing when the controller is disarmed — which is also
 * the only state a non-Claude session ever reports.
 */
const ClaudeAutoResumeBanner = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AutoResumeStatus | null>(null);

  useEffect(() => {
    const prev = window.updateClaudeAutoResumeStatus;
    window.updateClaudeAutoResumeStatus = (json: string) => {
      try {
        const parsed = JSON.parse(json) as Partial<AutoResumeStatus>;
        setStatus({
          armed: parsed.armed === true,
          wakeAt: typeof parsed.wakeAt === 'number' ? parsed.wakeAt : 0,
          manualResumeNeeded: parsed.manualResumeNeeded === true,
          windows: Array.isArray(parsed.windows) ? parsed.windows : [],
        });
      } catch {
        /* ignore malformed payload */
      }
    };
    return () => {
      window.updateClaudeAutoResumeStatus = prev;
    };
  }, []);

  const handleContinue = useCallback(() => {
    sendBridgeEvent('claude_auto_resume_manual');
    // Optimistically clear the banner; the backend disarms and pushes the
    // disarmed status right after it sends the resume prompt.
    setStatus(null);
  }, []);

  const wakeLabel = useMemo(() => {
    if (!status || status.wakeAt <= 0) {
      return null;
    }
    try {
      return new Date(status.wakeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  }, [status]);

  if (!status) {
    return null;
  }

  if (status.manualResumeNeeded) {
    return (
      <div className={`${styles.banner} ${styles.manual}`}>
        <span className="codicon codicon-history" />
        <span className={styles.text}>{t('chat.autoResume.manualPrompt')}</span>
        <button type="button" className={styles.continueBtn} onClick={handleContinue}>
          {t('chat.autoResume.continue')}
        </button>
      </div>
    );
  }

  if (status.armed) {
    return (
      <div className={`${styles.banner} ${styles.armed}`}>
        <span className="codicon codicon-watch" />
        <span className={styles.text}>
          {wakeLabel
            ? t('chat.autoResume.armedAt', { time: wakeLabel })
            : t('chat.autoResume.armed')}
        </span>
      </div>
    );
  }

  return null;
};

export default ClaudeAutoResumeBanner;
