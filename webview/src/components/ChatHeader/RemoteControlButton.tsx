import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import { sendToJava } from '../../utils/bridge';

type RemoteControlState = 'off' | 'pending' | 'on';

interface RemoteControlResult {
  success?: boolean;
  enabled?: boolean;
  error?: string;
}

interface RemoteControlButtonProps {
  t: TFunction;
  /** Only the Claude runtime carries the control request; the button hides for the rest. */
  provider?: string;
}

// Hands this very session to claude.ai instead of starting a second one there:
// the backend flips it on the runtime already answering in this panel, so the
// phone continues the conversation on screen rather than opening a blank one.
export default function RemoteControlButton({ t, provider = 'claude' }: RemoteControlButtonProps) {
  const [state, setState] = useState<RemoteControlState>('off');
  const [error, setError] = useState('');

  useEffect(() => {
    const previous = window.onRemoteControlResult;
    window.onRemoteControlResult = (json: string) => {
      if (previous) {
        previous(json);
      }

      let result: RemoteControlResult = {};
      try {
        result = JSON.parse(json) as RemoteControlResult;
      } catch {
        result = {};
      }

      if (result.success) {
        setError('');
        setState(result.enabled ? 'on' : 'off');
        return;
      }

      // A refused handover leaves the session local, so the button must fall back
      // to off — showing it lit would promise a phone that answers nothing.
      setState('off');
      setError(result.error || t('remoteControl.failed', { defaultValue: 'Remote Control request failed' }));
    };

    return () => {
      window.onRemoteControlResult = previous;
    };
  }, [t]);

  const toggle = useCallback(() => {
    if (state === 'pending') {
      return;
    }
    setError('');
    setState('pending');
    sendToJava('set_remote_control', { enabled: state !== 'on' });
  }, [state]);

  if (provider !== 'claude') {
    return null;
  }

  let label = t('remoteControl.enable', { defaultValue: 'Control this session from claude.ai' });
  if (state === 'on') {
    label = t('remoteControl.disable', { defaultValue: 'Stop controlling this session from claude.ai' });
  }
  if (state === 'pending') {
    label = t('remoteControl.connecting', { defaultValue: 'Connecting to Remote Control…' });
  }
  if (error) {
    label = error;
  }

  return (
    <button
      className="icon-button remote-control-button"
      data-testid="remote-control-button"
      data-state={state}
      data-failed={error.length > 0}
      onClick={toggle}
      disabled={state === 'pending'}
      data-tooltip={label}
      aria-label={label}
      aria-pressed={state === 'on'}
    >
      <span className="codicon codicon-radio-tower" />
    </button>
  );
}
