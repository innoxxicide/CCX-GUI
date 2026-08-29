import type { SubagentInfo } from '../../types';
import type { PipelineRun, StepRun } from './derivePipelineRun';
import { isSkipped } from './derivePipelineRun';

export interface TrackColumn {
  key: string;
  entries: StepRun[];
}

export interface OffTrackGroup {
  type: string;
  status: SubagentInfo['status'];
  agents: SubagentInfo[];
}

export type PanelSelection =
  | { kind: 'step'; id: string; role?: string }
  | { kind: 'offTrack'; type: string };

export interface SelectedAgents {
  key: string;
  agents: SubagentInfo[];
}

export interface RunSummary {
  done: number;
  /** Steps this run involves: one it was free to skip and did is not outstanding work. */
  total: number;
  running: string[];
  totalTokens: number;
  totalToolUseCount: number;
}

export function offTrackKey(type: string): string {
  return `offtrack:${type}`;
}

// Steps of one parallel group collapse into a single column, so the track renders
// a fan as one slot instead of as several sequential steps.
export function toColumns(steps: StepRun[]): TrackColumn[] {
  const columns: TrackColumn[] = [];
  for (const entry of steps) {
    const previous = columns[columns.length - 1];
    if (entry.step.group && previous && previous.key === entry.step.group) {
      previous.entries.push(entry);
      continue;
    }
    columns.push({ key: entry.step.group ?? entry.step.id, entries: [entry] });
  }
  return columns;
}

export function groupOffTrack(agents: SubagentInfo[]): OffTrackGroup[] {
  const groups: OffTrackGroup[] = [];
  for (const agent of agents) {
    const existing = groups.find((group) => group.type === agent.type);
    if (!existing) {
      groups.push({ type: agent.type, status: agent.status, agents: [agent] });
      continue;
    }
    existing.agents.push(agent);
    // A relaunch in flight outranks the run that failed, the same way a step reads.
    if (agent.status === 'running') existing.status = 'running';
    if (agent.status === 'error' && existing.status === 'completed') existing.status = 'error';
  }
  return groups;
}

/**
 * How long the run in a live step has been going, or null when the step cannot back
 * such a number: a slot holding several runs, a launch that carried no timestamp, or
 * a start in the future, which would otherwise count down.
 */
export function liveElapsedMs(entry: StepRun, now: number): number | null {
  if (entry.status !== 'running' || entry.agents.length !== 1) return null;
  const startedAt = Date.parse(entry.agents[0].startedAt ?? '');
  if (Number.isNaN(startedAt) || now < startedAt) return null;
  return now - startedAt;
}

// The rendered track can swap under an open pane when the mode settles late, so a
// selection whose step is gone follows its agent to the step that role owns now.
export function resolveSelection(run: PipelineRun, selection: PanelSelection | null): SelectedAgents | undefined {
  if (!selection) return undefined;
  if (selection.kind === 'offTrack') {
    const agents = run.offTrack.filter((agent) => agent.type === selection.type);
    if (agents.length === 0) return undefined;
    return { key: offTrackKey(selection.type), agents };
  }
  const onTrack = run.steps.find((entry) => entry.step.id === selection.id);
  if (onTrack) return { key: onTrack.step.id, agents: onTrack.agents };
  if (!selection.role) return undefined;
  const carried = run.steps.find((entry) => entry.step.role === selection.role && entry.agents.length > 0);
  if (!carried) return undefined;
  return { key: carried.step.id, agents: carried.agents };
}

// Duration is deliberately absent: agents run in parallel, so summing their
// wall-clock would report a run far longer than the one the reader sat through.
export function summarizeRun(run: PipelineRun): RunSummary {
  const involved = run.steps.filter((entry) => !isSkipped(entry));
  const agents = [...run.steps.flatMap((entry) => entry.agents), ...run.offTrack];
  return {
    done: involved.filter((entry) => entry.status === 'done').length,
    total: involved.length,
    running: run.steps.filter((entry) => entry.status === 'running').map((entry) => entry.step.label),
    totalTokens: agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0),
    totalToolUseCount: agents.reduce((sum, agent) => sum + (agent.totalToolUseCount ?? 0), 0),
  };
}
