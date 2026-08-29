import type { SubagentInfo } from '../../types';
import type { PipelineMode, PipelineStep } from './pipelineDescriptor';
import { PIPELINE_TRACKS } from './pipelineDescriptor';

export type PipelineStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface StepRun {
  step: PipelineStep;
  status: PipelineStepStatus;
  agents: SubagentInfo[];
}

export interface PipelineRun {
  mode: PipelineMode;
  steps: StepRun[];
  offTrack: SubagentInfo[];
}

/**
 * Roles that only ever run on the Full path, so seeing one settles the mode.
 * risk-analyst is deliberately absent: it also authors the lens set of a
 * branch-scale lens review, which is not a pipeline run at all.
 */
const FULL_ONLY_ROLES = ['ux-analyst', 'tech-architect', 'test-engineer'];

function inferMode(subagents: SubagentInfo[]): PipelineMode {
  const rolesRun = new Set(subagents.map((agent) => agent.type));
  if (FULL_ONLY_ROLES.some((role) => rolesRun.has(role))) return 'full';
  if (rolesRun.has('planner')) return 'standard';
  if (rolesRun.has('implementer')) return 'fast';
  return 'undetermined';
}

// The steps an orchestrator step waits on: the one before it, or every member of
// the parallel group when that one belongs to a fan, whose members finish in any order.
export function blockBefore(track: PipelineStep[], index: number): PipelineStep[] {
  const previous = track[index - 1];
  if (!previous) return [];
  if (!previous.group) return [previous];
  const block: PipelineStep[] = [];
  for (let cursor = index - 1; cursor >= 0 && track[cursor].group === previous.group; cursor -= 1) {
    block.unshift(track[cursor]);
  }
  return block;
}

// A step the contract lets a run leave out, and this run did: it is neither
// outstanding work nor something a later step can wait for.
export function isSkipped(entry: StepRun): boolean {
  return Boolean(entry.step.conditional) && entry.agents.length === 0;
}

function resolveStatus(entry: StepRun, precedingBlock: StepRun[], hasEvidence: boolean): PipelineStepStatus {
  // Orchestrator steps delegate nothing, so they are read off the steps before them,
  // minus the ones the run was free to skip: those never arrive and would freeze the track.
  if (entry.step.kind === 'orchestrator') {
    const awaited = precedingBlock.filter((before) => !isSkipped(before));
    if (awaited.length === 0) return hasEvidence ? 'done' : 'pending';
    return awaited.every((before) => before.status === 'done') ? 'done' : 'pending';
  }
  if (entry.agents.some((agent) => agent.status === 'running')) return 'running';
  if (entry.agents.some((agent) => agent.status === 'error')) return 'error';
  if (entry.agents.length > 0) return 'done';
  return 'pending';
}

/**
 * A role can own several steps (optimizer: cleanup pass, then review wave), so
 * runs are assigned in messageIndex order, each taking the first still-empty one.
 */
export function derivePipelineRun(subagents: SubagentInfo[]): PipelineRun {
  const mode = inferMode(subagents);
  const track = PIPELINE_TRACKS[mode === 'undetermined' ? 'standard' : mode];
  const steps: StepRun[] = track.map((step) => ({ step, status: 'pending', agents: [] }));
  const offTrack: SubagentInfo[] = [];

  const chronological = [...subagents].sort((a, b) => a.messageIndex - b.messageIndex);
  for (const agent of chronological) {
    const candidates = steps.filter((entry) => entry.step.role === agent.type);
    if (candidates.length === 0) {
      offTrack.push(agent);
      continue;
    }
    const target = candidates.find((entry) => entry.agents.length === 0) ?? candidates[candidates.length - 1];
    target.agents.push(agent);
  }

  steps.forEach((entry, index) => {
    const blockStart = index - blockBefore(track, index).length;
    entry.status = resolveStatus(entry, steps.slice(blockStart, index), subagents.length > 0);
  });

  return { mode, steps, offTrack };
}
