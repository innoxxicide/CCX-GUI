import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import { subagentStatusIconMap } from '../StatusPanel/types';
import { formatSubagentDuration } from '../StatusPanel/subagentProcess';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';
import { derivePipelineRun } from './derivePipelineRun';
import type { StepRun } from './derivePipelineRun';
import type { TrackMode } from './pipelineDescriptor';
import { groupOffTrack, liveElapsedMs, offTrackKey, resolveSelection, summarizeRun, toColumns } from './trackLayout';
import type { PanelSelection } from './trackLayout';
import './PipelineMonitor.less';

interface PipelineMonitorOverlayProps {
  subagents: SubagentInfo[];
  t: TFunction;
  onClose: () => void;
  /** Session whose sidechain transcripts back the details pane; null before the first turn. */
  sessionId?: string | null;
  provider?: string;
  histories?: Record<string, SubagentHistoryResponse>;
}

const LIVE_STATUS_ICON: Record<'running' | 'done' | 'error', SubagentInfo['status']> = {
  running: 'running',
  done: 'completed',
  error: 'error',
};

const NOT_REACHED_ICON = 'codicon-circle-outline';
const STALLED_ICON = 'codicon-warning';

function agentIcon(status: SubagentInfo['status']): string {
  // A status widened upstream would otherwise render as `codicon undefined`, an invisible chip;
  // it reads as unknown rather than as not-reached, which is a state we would be claiming.
  return subagentStatusIconMap[status] ?? 'codicon-question';
}

function stepIcon(entry: StepRun): string {
  // Ahead of the orchestrator check: a dead end is worth more to the reader than the step kind.
  if (entry.status === 'stalled') return STALLED_ICON;
  if (entry.step.kind === 'orchestrator') return 'codicon-checklist';
  if (entry.status === 'pending') return NOT_REACHED_ICON;
  return agentIcon(LIVE_STATUS_ICON[entry.status as 'running' | 'done' | 'error']);
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

function statusNote(entry: StepRun, t: TFunction): string | undefined {
  if (entry.status === 'stalled') {
    return t('pipelineMonitor.stalled', { defaultValue: 'interrupted — never reported back' });
  }
  if (entry.step.conditional && entry.status === 'pending') {
    return t('pipelineMonitor.conditional', { defaultValue: 'conditional' });
  }
  return undefined;
}

export default function PipelineMonitorOverlay({
  subagents,
  t,
  onClose,
  sessionId = null,
  provider = 'claude',
  histories = {},
}: PipelineMonitorOverlayProps) {
  const [selection, setSelection] = useState<PanelSelection | null>(null);
  const [pickedMode, setPickedMode] = useState<TrackMode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const run = useMemo(() => derivePipelineRun(subagents, pickedMode ?? undefined), [subagents, pickedMode]);
  const columns = useMemo(() => toColumns(run.steps), [run]);
  const offTrackGroups = useMemo(() => groupOffTrack(run.offTrack), [run]);
  const summary = useMemo(() => summarizeRun(run), [run]);
  const stalledIds = useMemo(() => new Set(run.stalledAgentIds), [run]);
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

  // Picking the mode already on screen goes back to reading it off the agents that ran.
  const pickMode = (mode: TrackMode) => {
    setPickedMode((current) => (current === mode ? null : mode));
  };

  // A settled run has nothing left to count, so it does not re-render once a second.
  // A stalled step is not counted either: nothing is running behind that spinner.
  const hasLiveStep = run.steps.some((entry) => entry.status === 'running');

  useEffect(() => {
    if (!hasLiveStep) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [hasLiveStep]);

  // An agent that never reported back left its work in its own sidechain transcript.
  // Asking for it once per agent is what turns a frozen step into a readable one; the
  // reply also settles agents whose transcript does end with a terminal turn.
  const unsettled = useMemo(() => subagents.filter((agent) => agent.status === 'running'), [subagents]);
  const requestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!sessionId) return;
    for (const agent of unsettled) {
      if (requestedRef.current.has(agent.id)) continue;
      requestedRef.current.add(agent.id);
      sendBridgeEvent('load_subagent_session', JSON.stringify({
        sessionId,
        provider,
        agentId: agent.agentId,
        agentPath: agent.agentPath,
        description: agent.description,
        toolUseId: agent.id,
      }));
    }
  }, [provider, sessionId, unsettled]);

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

  const modeChips: Array<{ mode: TrackMode; label: string }> = [
    { mode: 'fast', label: t('pipelineMonitor.modeFast', { defaultValue: 'Fast' }) },
    { mode: 'standard', label: t('pipelineMonitor.modeStandard', { defaultValue: 'Standard' }) },
    { mode: 'full', label: t('pipelineMonitor.modeFull', { defaultValue: 'Full' }) },
  ];
  const summaryTotals = statsLine(t, 0, summary.totalToolUseCount, summary.totalTokens);
  const runCount = run.steps.reduce((sum, entry) => sum + entry.agents.length, 0) + run.offTrack.length;

  return createPortal(
    <div className="pipeline-monitor-backdrop" onClick={handleBackdropClick}>
      <div className="pipeline-monitor-panel" data-testid="pipeline-monitor-overlay" data-mode={run.mode}>
        <div className="pipeline-monitor-header">
          <div className="pipeline-monitor-title">
            {t('pipelineMonitor.title', { defaultValue: 'Agent pipeline' })}
          </div>
          <div className="pipeline-monitor-modes">
            {modeChips.map((chip) => (
              <button
                key={chip.mode}
                type="button"
                className="pipeline-mode-badge"
                data-testid="pipeline-mode-badge"
                data-active={run.mode === chip.mode}
                data-picked={pickedMode === chip.mode}
                title={t('pipelineMonitor.pickMode', { defaultValue: 'Draw this track instead of the detected one' })}
                onClick={() => pickMode(chip.mode)}
              >
                {chip.label}
              </button>
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
          {run.steps.length > 0 ? (
            <span className="pipeline-summary-progress">
              {`${summary.done}/${summary.total} `}
              {t('pipelineMonitor.stepsDone', { defaultValue: 'steps done' })}
            </span>
          ) : (
            <span className="pipeline-summary-progress">
              {`${runCount} `}
              {t('pipelineMonitor.agentRuns', { defaultValue: 'Agent runs' }).toLowerCase()}
            </span>
          )}
          {summary.running.length > 0 && (
            <span className="pipeline-summary-running">
              <span className="codicon codicon-loading" />
              {summary.running.join(', ')}
            </span>
          )}
          {summary.stalled.length > 0 && (
            <span className="pipeline-summary-stalled" data-testid="pipeline-summary-stalled">
              <span className={`codicon ${STALLED_ICON}`} />
              {summary.stalled.join(', ')}
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

        {run.mode === 'none' && (
          <div className="pipeline-monitor-hint" data-testid="pipeline-monitor-no-track">
            {t('pipelineMonitor.notAPipeline', {
              defaultValue: 'Not a pipeline run — listing the agents as they were launched. Pick a track above to draw one anyway.',
            })}
          </div>
        )}

        {columns.length > 0 && (
          <div className="pipeline-monitor-track">
            {columns.map((column) => (
              <div key={column.key} className="pipeline-track-column" data-parallel={column.entries.length > 1}>
                {column.entries.map((entry) => {
                  const meta = stepMeta(entry, t, now);
                  const failure = errorPreview(entry);
                  const note = statusNote(entry, t);
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
                      {note && <span className="pipeline-step-note">{note}</span>}
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
        )}

        {selected && selected.agents.length > 0 && (
          <div className="pipeline-monitor-details">
            {selected.agents.map((agent) => (
              <div key={agent.id} className="pipeline-monitor-detail">
                {stalledIds.has(agent.id) && (
                  <div className="pipeline-detail-stalled" data-testid="pipeline-stalled-note">
                    {t('pipelineMonitor.stalledNote', {
                      defaultValue: 'This agent never reported back — the session was interrupted while it ran. Below is what its transcript still holds.',
                    })}
                  </div>
                )}
                <SubagentProcessDetails
                  agentId={agent.agentId}
                  totalDurationMs={agent.totalDurationMs}
                  totalTokens={agent.totalTokens}
                  totalToolUseCount={agent.totalToolUseCount}
                  resultText={agent.resultText}
                  prompt={agent.prompt}
                  history={histories[agent.id] ?? (agent.agentId ? histories[agent.agentId] : undefined)}
                  canLoad={Boolean(sessionId)}
                />
              </div>
            ))}
          </div>
        )}

        {offTrackGroups.length > 0 && (
          <div className="pipeline-monitor-offtrack">
            <div className="pipeline-monitor-offtrack-title">
              {run.steps.length > 0
                ? t('pipelineMonitor.offTrack', { defaultValue: 'Off track' })
                : t('pipelineMonitor.agentRuns', { defaultValue: 'Agent runs' })}
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
