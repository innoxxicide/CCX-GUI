import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import type { SubagentInfo } from '../../types';
import { subagentStatusIconMap } from '../StatusPanel/types';
import { formatSubagentDuration } from '../StatusPanel/subagentProcess';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';
import { derivePipelineRun } from './derivePipelineRun';
import type { PipelineStepStatus, StepRun } from './derivePipelineRun';
import { groupOffTrack, liveElapsedMs, offTrackKey, resolveSelection, summarizeRun, toColumns } from './trackLayout';
import type { PanelSelection } from './trackLayout';
import './PipelineMonitor.less';

interface PipelineMonitorOverlayProps {
  subagents: SubagentInfo[];
  t: TFunction;
  onClose: () => void;
}

const LIVE_STATUS_ICON: Record<Exclude<PipelineStepStatus, 'pending'>, SubagentInfo['status']> = {
  running: 'running',
  done: 'completed',
  error: 'error',
};

const NOT_REACHED_ICON = 'codicon-circle-outline';

function agentIcon(status: SubagentInfo['status']): string {
  // A status widened upstream would otherwise render as `codicon undefined`, an invisible chip;
  // it reads as unknown rather than as not-reached, which is a state we would be claiming.
  return subagentStatusIconMap[status] ?? 'codicon-question';
}

function stepIcon(entry: StepRun): string {
  if (entry.step.kind === 'orchestrator') return 'codicon-checklist';
  if (entry.status === 'pending') return NOT_REACHED_ICON;
  return agentIcon(LIVE_STATUS_ICON[entry.status]);
}

function statsLine(t: TFunction, durationMs: number, toolUseCount: number, tokens: number): string {
  const duration = durationMs > 0
    ? formatSubagentDuration(durationMs, { ms: t('subagent.process.unitMs'), s: t('subagent.process.unitS') })
    : null;
  const tools = toolUseCount > 0 ? `${toolUseCount} ${t('subagent.process.unitTools')}` : null;
  const tokenText = tokens > 0 ? `${tokens.toLocaleString()} ${t('subagent.process.unitTokens')}` : null;
  return [duration, tools, tokenText].filter(Boolean).join(' · ');
}

function stepMeta(entry: StepRun, t: TFunction, now: number): string {
  // Wall-clock does not add up across the runs of one slot, so only a single-run slot
  // reports elapsed time; tool calls and tokens do add up, and stay visible on both.
  const singleRun = entry.agents.length === 1 ? entry.agents[0] : null;
  return statsLine(
    t,
    singleRun?.totalDurationMs ?? liveElapsedMs(entry, now) ?? 0,
    entry.agents.reduce((sum, agent) => sum + (agent.totalToolUseCount ?? 0), 0),
    entry.agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0),
  );
}

function errorPreview(entry: StepRun): string | undefined {
  if (entry.status !== 'error') return undefined;
  const failed = entry.agents.find((agent) => agent.status === 'error');
  return failed?.resultText?.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120);
}

export default function PipelineMonitorOverlay({ subagents, t, onClose }: PipelineMonitorOverlayProps) {
  const [selection, setSelection] = useState<PanelSelection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const run = useMemo(() => derivePipelineRun(subagents), [subagents]);
  const columns = useMemo(() => toColumns(run.steps), [run]);
  const offTrackGroups = useMemo(() => groupOffTrack(run.offTrack), [run]);
  const summary = useMemo(() => summarizeRun(run), [run]);
  const selected = resolveSelection(run, selection);

  const toggleStep = (entry: StepRun) => {
    if (selected?.key === entry.step.id) {
      setSelection(null);
      return;
    }
    setSelection({ kind: 'step', id: entry.step.id, role: entry.step.role });
  };

  const toggleOffTrack = (type: string) => {
    if (selected?.key === offTrackKey(type)) {
      setSelection(null);
      return;
    }
    setSelection({ kind: 'offTrack', type });
  };

  // A settled run has nothing left to count, so it does not re-render once a second.
  const hasLiveStep = run.steps.some((entry) => entry.status === 'running');

  useEffect(() => {
    if (!hasLiveStep) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [hasLiveStep]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // window, like every sibling dialog: on document this fires first and closes an underlying one too.
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleBackdropClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const modeChips: Array<{ mode: 'fast' | 'standard' | 'full'; label: string }> = [
    { mode: 'fast', label: t('pipelineMonitor.modeFast', { defaultValue: 'Fast' }) },
    { mode: 'standard', label: t('pipelineMonitor.modeStandard', { defaultValue: 'Standard' }) },
    { mode: 'full', label: t('pipelineMonitor.modeFull', { defaultValue: 'Full' }) },
  ];
  const summaryTotals = statsLine(t, 0, summary.totalToolUseCount, summary.totalTokens);

  return createPortal(
    <div className="pipeline-monitor-backdrop" onClick={handleBackdropClick}>
      <div className="pipeline-monitor-panel" data-testid="pipeline-monitor-overlay" data-mode={run.mode}>
        <div className="pipeline-monitor-header">
          <div className="pipeline-monitor-title">
            {t('pipelineMonitor.title', { defaultValue: 'Agent pipeline' })}
          </div>
          <div className="pipeline-monitor-modes">
            {modeChips.map((chip) => (
              <span
                key={chip.mode}
                className="pipeline-mode-badge"
                data-testid="pipeline-mode-badge"
                data-active={run.mode === chip.mode}
              >
                {chip.label}
              </span>
            ))}
          </div>
          <button
            className="pipeline-monitor-close"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="pipeline-monitor-summary" data-testid="pipeline-monitor-summary">
          <span className="pipeline-summary-progress">
            {`${summary.done}/${summary.total} `}
            {t('pipelineMonitor.stepsDone', { defaultValue: 'steps done' })}
          </span>
          {summary.running.length > 0 && (
            <span className="pipeline-summary-running">
              <span className="codicon codicon-loading" />
              {summary.running.join(', ')}
            </span>
          )}
          {summaryTotals && <span className="pipeline-summary-totals">{summaryTotals}</span>}
        </div>

        {run.mode === 'undetermined' && (
          <div className="pipeline-monitor-hint">
            {t('pipelineMonitor.undetermined', {
              defaultValue: 'Path not determined yet — showing the Standard track.',
            })}
          </div>
        )}

        <div className="pipeline-monitor-track">
          {columns.map((column) => (
            <div key={column.key} className="pipeline-track-column" data-parallel={column.entries.length > 1}>
              {column.entries.map((entry) => {
                const meta = stepMeta(entry, t, now);
                const failure = errorPreview(entry);
                return (
                  <button
                    key={entry.step.id}
                    type="button"
                    className="pipeline-step"
                    data-testid="pipeline-step"
                    data-state={entry.status}
                    data-step-id={entry.step.id}
                    data-selected={entry.step.id === selected?.key}
                    onClick={() => toggleStep(entry)}
                  >
                    <span className="pipeline-step-head">
                      <span className={`pipeline-step-icon codicon ${stepIcon(entry)}`} />
                      <span className="pipeline-step-label">{entry.step.label}</span>
                      {entry.agents.length > 1 && (
                        <span className="pipeline-step-count">{`×${entry.agents.length}`}</span>
                      )}
                    </span>
                    {entry.step.conditional && entry.status === 'pending' && (
                      <span className="pipeline-step-note">
                        {t('pipelineMonitor.conditional', { defaultValue: 'conditional' })}
                      </span>
                    )}
                    {failure && (
                      <span className="pipeline-step-error" data-testid="pipeline-step-error">{failure}</span>
                    )}
                    {meta && <span className="pipeline-step-meta">{meta}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {selected && selected.agents.length > 0 && (
          <div className="pipeline-monitor-details">
            {selected.agents.map((agent) => (
              <SubagentProcessDetails
                key={agent.id}
                agentId={agent.agentId}
                totalDurationMs={agent.totalDurationMs}
                totalTokens={agent.totalTokens}
                totalToolUseCount={agent.totalToolUseCount}
                resultText={agent.resultText}
                prompt={agent.prompt}
                canLoad={false}
              />
            ))}
          </div>
        )}

        {offTrackGroups.length > 0 && (
          <div className="pipeline-monitor-offtrack">
            <div className="pipeline-monitor-offtrack-title">
              {t('pipelineMonitor.offTrack', { defaultValue: 'Off track' })}
            </div>
            <div className="pipeline-monitor-offtrack-list">
              {offTrackGroups.map((group) => (
                <button
                  key={group.type}
                  type="button"
                  className="pipeline-offtrack-chip"
                  data-testid="pipeline-offtrack-agent"
                  data-selected={selected?.key === offTrackKey(group.type)}
                  onClick={() => toggleOffTrack(group.type)}
                >
                  <span className={`codicon ${agentIcon(group.status)}`} />
                  {group.type}
                  {group.agents.length > 1 && (
                    <span className="pipeline-step-count">{`×${group.agents.length}`}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
