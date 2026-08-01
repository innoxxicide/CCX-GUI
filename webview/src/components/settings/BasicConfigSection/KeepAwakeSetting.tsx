import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';

/** Mirrors {@code KeepAwakeSettings} in the Java backend. */
const FIELD = 'keepAwakeWhileAgentWorksEnabled';

/**
 * "Keep the computer awake while an agent is working" toggle, rendered under
 * Basic > Behavior. Provider-agnostic and account-global.
 *
 * <p>Owns its own IPC rather than joining the BehaviorTab prop chain: the value
 * is neither project- nor provider-scoped, and threading one more pair of
 * props through App → BasicConfigSection → BehaviorTab would buy nothing.
 * Same shape as ClaudeAutoResumeSetting, for the same reason.
 */
export function KeepAwakeSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const previous = window.updateKeepAwakeEnabled;

    window.updateKeepAwakeEnabled = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { keepAwakeWhileAgentWorksEnabled?: boolean };
        setEnabled(parsed.keepAwakeWhileAgentWorksEnabled === true);
      } catch {
        /* ignore malformed payload */
      }
    };

    sendBridgeEvent('get_keep_awake_enabled');

    return () => {
      window.updateKeepAwakeEnabled = previous;
    };
  }, []);

  const handleToggle = useCallback((checked: boolean) => {
    setEnabled(checked);
    sendToJava('set_keep_awake_enabled', { [FIELD]: checked });
  }, []);

  return (
    <div className={styles.streamingSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-device-desktop" />
        <span className={styles.fieldLabel}>{t('settings.basic.keepAwake.label')}</span>
      </div>
      <label className={styles.toggleWrapper}>
        <input
          type="checkbox"
          className={styles.toggleInput}
          checked={enabled}
          onChange={(e) => handleToggle(e.target.checked)}
        />
        <span className={styles.toggleSlider} />
        <span className={styles.toggleLabel}>
          {enabled ? t('settings.basic.keepAwake.enabled') : t('settings.basic.keepAwake.disabled')}
        </span>
      </label>
      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{t('settings.basic.keepAwake.hint')}</span>
      </small>
    </div>
  );
}

export default KeepAwakeSetting;
