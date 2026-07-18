import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';
import styles from './style.module.less';

/** Mirrors {@code ClaudeAutoResumeSettings} in the Java backend. */
const DEFAULT_PROMPT = 'Please continue where you left off.';
const MAX_PROMPT_LENGTH = 10000;

/**
 * Claude-only "auto-resume after usage-limit reset" setting, rendered under the
 * Providers > Claude tab. Owns its own IPC: it registers the two update
 * callbacks the Java backend pushes to, requests the current values on mount,
 * and echoes changes back. Kept self-contained so it doesn't thread through the
 * App-level settings prop chain (this value is Claude-scoped and account-global).
 */
const ClaudeAutoResumeSetting = () => {
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
    const prevEnabled = window.updateClaudeAutoResumeEnabled;
    const prevPrompt = window.updateClaudeAutoResumePrompt;

    window.updateClaudeAutoResumeEnabled = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { claudeAutoResumeOnLimitEnabled?: boolean };
        setEnabled(parsed.claudeAutoResumeOnLimitEnabled === true);
      } catch {
        /* ignore malformed payload */
      }
    };
    window.updateClaudeAutoResumePrompt = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { claudeAutoResumePrompt?: string };
        if (typeof parsed.claudeAutoResumePrompt === 'string') {
          setPrompt(parsed.claudeAutoResumePrompt);
        }
      } catch {
        /* ignore malformed payload */
      }
    };

    sendBridgeEvent('get_claude_auto_resume_enabled');
    sendBridgeEvent('get_claude_auto_resume_prompt');

    return () => {
      window.updateClaudeAutoResumeEnabled = prevEnabled;
      window.updateClaudeAutoResumePrompt = prevPrompt;
    };
  }, []);

  const handleToggle = useCallback((checked: boolean) => {
    setEnabled(checked);
    sendToJava('set_claude_auto_resume_enabled', { claudeAutoResumeOnLimitEnabled: checked });
  }, []);

  const commitPrompt = useCallback(() => {
    const trimmed = promptInput.trim().slice(0, MAX_PROMPT_LENGTH);
    const effective = trimmed.length === 0 ? DEFAULT_PROMPT : trimmed;
    setPromptInput(effective);
    setPrompt(effective);
    sendToJava('set_claude_auto_resume_prompt', { claudeAutoResumePrompt: effective });
  }, [promptInput]);

  return (
    <div className={styles.autoResumeSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-history" />
        <span className={styles.fieldLabel}>{t('settings.claudeAutoResume.title')}</span>
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
          {enabled
            ? t('settings.claudeAutoResume.enabled')
            : t('settings.claudeAutoResume.disabled')}
        </span>
      </label>

      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{t('settings.claudeAutoResume.hint')}</span>
      </small>

      <div className={styles.promptField}>
        <label className={styles.promptLabel} htmlFor="claude-auto-resume-prompt">
          {t('settings.claudeAutoResume.promptLabel')}
        </label>
        <textarea
          id="claude-auto-resume-prompt"
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
          <span>{t('settings.claudeAutoResume.promptHint')}</span>
        </small>
      </div>
    </div>
  );
};

export default ClaudeAutoResumeSetting;
