import type { SubagentInfo } from '../../types';
import type { PipelineMode, PipelineStep, TrackMode } from './pipelineDescriptor';
import { PIPELINE_TRACKS } from './pipelineDescriptor';

export type PipelineStepStatus = 'pending' | 'running' | 'stalled' | 'done' | 'error';

export interface StepRun {
  step: PipelineStep;
  status: PipelineStepStatus;
  agents: SubagentInfo[];
}

export interface PipelineRun {
  /** The track being drawn: what the run looks like, or what the reader picked instead. */
  mode: PipelineMode;
  /** What the agents that ran say the route is, whatever the reader picked. */
  detectedMode: PipelineMode;
  steps: StepRun[];
  offTrack: SubagentInfo[];
  /** Agents still claiming to run after the pipeline walked past their step. */
  stalledAgentIds: string[];
}

/**
 * Roles that only ever run on the Full path, so seeing one settles the mode.
 * risk-analyst is deliberately absent: it also authors the lens set of a
 * branch-scale lens review, which is not a pipeline run at all.
 */
const FULL_ONLY_ROLES = ['ux-analyst', 'tech-architect', 'test-engineer'];

/**
 * Roles that run before the route is chosen. A run holding only these has not
 * revealed its track yet — unlike one whose agents belong to no track at all.
 */
const PRE_ROUTE_ROLES = ['triage'];

function inferMode(subagents: SubagentInfo[]): PipelineMode {
  if (subagents.length === 0) return 'idle';
  const rolesRun = new Set(subagents.map((agent) => agent.type));
  if (FULL_ONLY_ROLES.some((role) => rolesRun.has(role))) return 'full';
  if (rolesRun.has('planner')) return 'standard';
  if (rolesRun.has('implementer')) return 'fast';
  if ([...rolesRun].every((role) => PRE_ROUTE_ROLES.includes(role))) return 'undetermined';
  return 'none';
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

/**
 * A background agent's terminal status arrives as a separate notification, and an
 * interrupted session (usage limit, reload) can lose it — the agent then claims to
 * run for the rest of the conversation and every step behind it stays unreached.
 *
 * The proof that it is not running is the pipeline itself: a later step already has
 * agents, so the orchestrator got its answer. Members of one parallel group are
 * excluded — there the last-launched member routinely finishes first, and reading
 * that as a stall would condemn a healthy live wave.
 */
function collectStalled(steps: StepRun[]): Set<string> {
  const stalled = new Set<string>();
  steps.forEach((entry, index) => {
    const live = entry.agents.filter((agent) => agent.status === 'running');
    if (live.length === 0) return;
    const overtaken = steps.slice(index + 1).some((later) => (
      later.agents.length > 0 && (!entry.step.group || later.step.group !== entry.step.group)
    ));
    if (!overtaken) return;
    for (const agent of live) {
      stalled.add(agent.id);
    }
  });
  return stalled;
}

function resolveStatus(
  entry: StepRun,
  precedingBlock: StepRun[],
  hasEvidence: boolean,
  stalled: Set<string>,
): PipelineStepStatus {
  // Orchestrator steps delegate nothing, so they are read off the steps before them,
  // minus the ones the run was free to skip: those never arrive and would freeze the track.
  if (entry.step.kind === 'orchestrator') {
    const awaited = precedingBlock.filter((before) => !isSkipped(before));
    if (awaited.length === 0) return hasEvidence ? 'done' : 'pending';
    if (awaited.every((before) => before.status === 'done')) return 'done';
    // Waiting on a step that will never report is not waiting, it is a dead end.
    if (awaited.every((before) => before.status === 'done' || before.status === 'stalled')) return 'stalled';
    return 'pending';
  }
  if (entry.agents.some((agent) => agent.status === 'running' && !stalled.has(agent.id))) return 'running';
  if (entry.agents.some((agent) => agent.status === 'error')) return 'error';
  // A relaunch that reported back settles the step, whatever became of the run it replaced.
  if (entry.agents.some((agent) => agent.status === 'completed')) return 'done';
  if (entry.agents.some((agent) => stalled.has(agent.id))) return 'stalled';
  return 'pending';
}

/**
 * A role can own several steps (optimizer: cleanup pass, then review wave), so
 * runs are assigned in messageIndex order, each taking the first still-empty one.
 * `override` draws the track the reader picked instead of the detected one.
 */
export function derivePipelineRun(subagents: SubagentInfo[], override?: TrackMode): PipelineRun {
  const detectedMode = inferMode(subagents);
  const mode = override ?? detectedMode;
  // Neither mode owns a track: one has agents that walk no path, the other has no agents.
  if (mode === 'none' || mode === 'idle') {
    return { mode, detectedMode, steps: [], offTrack: [...subagents], stalledAgentIds: [] };
  }

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

  const stalled = collectStalled(steps);
  steps.forEach((entry, index) => {
    const blockStart = index - blockBefore(track, index).length;
    entry.status = resolveStatus(entry, steps.slice(blockStart, index), subagents.length > 0, stalled);
  });

  return { mode, detectedMode, steps, offTrack, stalledAgentIds: [...stalled] };
}
