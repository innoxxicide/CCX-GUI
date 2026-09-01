import { useCallback, useState } from 'react';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import PipelineMonitorOverlay from './PipelineMonitorOverlay';

interface PipelineMonitorButtonProps {
  subagents: SubagentInfo[];
  t: TFunction;
  sessionId?: string | null;
  provider?: string;
  histories?: Record<string, SubagentHistoryResponse>;
}

export default function PipelineMonitorButton({ subagents, t, sessionId, provider, histories }: PipelineMonitorButtonProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = t('pipelineMonitor.open', { defaultValue: 'Agent pipeline' });

  return (
    <>
      <button
        className="icon-button"
        data-testid="pipeline-monitor-button"
        onClick={() => setOpen(true)}
        data-tooltip={label}
        aria-label={label}
      >
        <span className="codicon codicon-type-hierarchy" />
      </button>
      {open && (
        <PipelineMonitorOverlay
          subagents={subagents}
          t={t}
          onClose={close}
          sessionId={sessionId}
          provider={provider}
          histories={histories}
        />
      )}
    </>
  );
}
