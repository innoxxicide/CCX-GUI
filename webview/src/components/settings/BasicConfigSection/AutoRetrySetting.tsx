import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';

/** Mirrors {@code AutoRetrySettings} in the Java backend. */
const DEFAULT_PROMPT = 'Continue working on the task.';
const MAX_PROMPT_LENGTH = 10000;

/**
 * "Retry automatically after an error" toggle and its nudge text, rendered under
 * Basic > Behavior. Provider-agnostic and account-global — any provider's turn
 * can die on an API error.
 *
 * <p>Usage-limit stops are excluded and handled by the Claude-only auto-resume
 * setting instead, which waits for the reset time rather than retrying.
 *
 * <p>Owns its own IPC for the same reason {@code KeepAwakeSetting} does: the
 * value is neither project- nor provider-scoped, so threading it through
 * App → BasicConfigSection → BehaviorTab would buy nothing.
 */
export function AutoRetrySetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [promptInput, setPromptInput] = useState(DEFAULT_PROMPT);

  // Re-sync the editable field whenever the backend echoes an authoritative
  // (normalized) value — e.g. an empty submission is coerced back to default.
  useEffect(() => {
    setPromptInput(prompt);
  }, [prompt]);

  useEffect(() => {
    const previousEnabled = window.updateAutoRetryEnabled;
    const previousPrompt = window.updateAutoRetryPrompt;

    window.updateAutoRetryEnabled = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { autoRetryOnErrorEnabled?: boolean };
        setEnabled(parsed.autoRetryOnErrorEnabled === true);
      } catch {
        /* ignore malformed payload */
      }
    };
    window.updateAutoRetryPrompt = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { autoRetryPrompt?: string };
        if (typeof parsed.autoRetryPrompt === 'string') {
          setPrompt(parsed.autoRetryPrompt);
        }
      } catch {
        /* ignore malformed payload */
      }
    };

    sendBridgeEvent('get_auto_retry_enabled');
    sendBridgeEvent('get_auto_retry_prompt');

    return () => {
      window.updateAutoRetryEnabled = previousEnabled;
      window.updateAutoRetryPrompt = previousPrompt;
    };
  }, []);

  const handleToggle = useCallback((checked: boolean) => {
    setEnabled(checked);
    sendToJava('set_auto_retry_enabled', { autoRetryOnErrorEnabled: checked });
  }, []);

  const commitPrompt = useCallback(() => {
    const trimmed = promptInput.trim().slice(0, MAX_PROMPT_LENGTH);
    const effective = trimmed.length === 0 ? DEFAULT_PROMPT : trimmed;
    setPromptInput(effective);
    setPrompt(effective);
    sendToJava('set_auto_retry_prompt', { autoRetryPrompt: effective });
  }, [promptInput]);

  return (
    <div className={styles.streamingSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-debug-restart" />
        <span className={styles.fieldLabel}>{t('settings.basic.autoRetry.label')}</span>
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
          {enabled ? t('settings.basic.autoRetry.enabled') : t('settings.basic.autoRetry.disabled')}
        </span>
      </label>

      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{t('settings.basic.autoRetry.hint')}</span>
      </small>

      <div className={styles.promptField}>
        <label className={styles.promptLabel} htmlFor="auto-retry-prompt">
          {t('settings.basic.autoRetry.promptLabel')}
        </label>
        <textarea
          id="auto-retry-prompt"
          className={styles.promptTextarea}
          value={promptInput}
          maxLength={MAX_PROMPT_LENGTH}
          rows={2}
          placeholder={DEFAULT_PROMPT}
          onChange={(e) => setPromptInput(e.target.value)}
          onBlur={commitPrompt}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commitPrompt();
            }
          }}
        />
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.autoRetry.promptHint')}</span>
        </small>
      </div>
    </div>
  );
}

export default AutoRetrySetting;
