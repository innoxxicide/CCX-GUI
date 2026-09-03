import { describe, expect, it } from 'vitest';
import type { SubagentInfo, SubagentStatus } from '../../types';
import type { PipelineRun, PipelineStepStatus, StepRun } from './derivePipelineRun';
import { derivePipelineRun } from './derivePipelineRun';
import type { PipelineStep } from './pipelineDescriptor';
import {
  buildLinks,
  columnLabel,
  groupOffTrack,
  liveElapsedMs,
  offTrackKey,
  resolveSelection,
  summarizeRun,
  toColumns,
} from './trackLayout';

let sequence = 0;

function mk(type: string, status: SubagentStatus, opts?: Partial<SubagentInfo>): SubagentInfo {
  sequence += 1;
  return {
    id: `s${sequence}`,
    type,
    description: type,
    status,
    messageIndex: sequence,
    ...opts,
  };
}

function entry(step: PipelineStep): StepRun {
  return { step, status: 'pending', agents: [] };
}

function agent(id: string, label: string, group?: string): PipelineStep {
  return { id, label, role: id, kind: 'agent', group };
}

function mkRun(steps: StepRun[], offTrack: SubagentInfo[] = []): PipelineRun {
  return { mode: 'fast', detectedMode: 'fast', steps, offTrack, stalledAgentIds: [] };
}

function ran(id: string, role: string): StepRun {
  return {
    step: { id, label: id, role, kind: 'agent' },
    status: 'done',
    agents: [mk(role, 'completed')],
  };
}

const SKIPPED_CLEANUP_RUN = [
  mk('planner', 'completed'),
  mk('implementer', 'completed'),
  mk('validator', 'completed'),
  mk('reviewer', 'completed'),
  mk('code-reviewer', 'completed'),
];

describe('toColumns', () => {
  it('gives every ungrouped step a column of its own, keyed by step id', () => {
    const columns = toColumns([entry(agent('planner', 'Planner')), entry(agent('implementer', 'Implementer'))]);

    expect(columns.map((column) => column.key)).toEqual(['planner', 'implementer']);
    expect(columns.every((column) => column.entries.length === 1)).toBe(true);
  });

  it('collapses consecutive steps of one group into a single column keyed by the group', () => {
    const columns = toColumns([
      entry(agent('validator', 'Validator')),
      entry(agent('reviewer', 'Reviewer', 'review-wave')),
      entry(agent('code-reviewer', 'Code review', 'review-wave')),
      entry(agent('optimizer-phase2', 'Optimizer', 'review-wave')),
      entry(agent('closer', 'Closer')),
    ]);

    expect(columns.map((column) => column.key)).toEqual(['validator', 'review-wave', 'closer']);
    expect(columns[1].entries.map((item) => item.step.id)).toEqual([
      'reviewer',
      'code-reviewer',
      'optimizer-phase2',
    ]);
  });

  it('keeps two runs of the same group name apart when a step separates them', () => {
    const columns = toColumns([
      entry(agent('reviewer', 'Reviewer', 'review-wave')),
      entry(agent('validator', 'Validator')),
      entry(agent('code-reviewer', 'Code review', 'review-wave')),
    ]);

    expect(columns).toHaveLength(3);
    expect(columns.map((column) => column.entries.length)).toEqual([1, 1, 1]);
  });

  it('renders the standard review wave as one column and leaves the rest single', () => {
    const run = derivePipelineRun([], 'standard');
    const columns = toColumns(run.steps);
    const fans = columns.filter((column) => column.entries.length > 1);

    expect(fans).toHaveLength(1);
    expect(fans[0].key).toBe('review-wave');
    expect(columns.reduce((sum, column) => sum + column.entries.length, 0)).toBe(run.steps.length);
  });
});

describe('buildLinks', () => {
  function step(
    id: string,
    status: PipelineStepStatus,
    opts?: { conditional?: boolean; group?: string; agents?: SubagentInfo[] },
  ): StepRun {
    return {
      step: { id, label: id, role: id, kind: 'agent', conditional: opts?.conditional, group: opts?.group },
      status,
      agents: opts?.agents ?? (status === 'pending' ? [] : [mk(id, 'completed')]),
    };
  }

  function states(steps: StepRun[]): Array<string | null> {
    return buildLinks(toColumns(steps)).map((link) => link?.state ?? null);
  }

  it('leaves the first column without a link — nothing reaches it from inside the track', () => {
    expect(states([step('planner', 'done'), step('implementer', 'done')])[0]).toBeNull();
  });

  it('reads the link as carrying once both ends of the handoff have settled', () => {
    expect(states([step('planner', 'done'), step('implementer', 'done')])[1]).toBe('carried');
  });

  it('reads the link as flowing while the step after works off the report it got', () => {
    expect(states([step('planner', 'done'), step('implementer', 'running')])[1]).toBe('flowing');
    expect(states([step('planner', 'done'), step('implementer', 'pending')]), 'handed over, not taken up yet')
      .toEqual([null, 'flowing']);
  });

  it('carries nothing out of a step that has not reported yet', () => {
    expect(states([step('planner', 'running'), step('implementer', 'pending')])[1]).toBe('idle');
  });

  it('marks the link blocked when the step before it never reported back', () => {
    expect(states([step('planner', 'stalled'), step('implementer', 'pending')])[1]).toBe('blocked');
    expect(states([step('planner', 'error'), step('implementer', 'pending')])[1]).toBe('blocked');
  });

  it('waits for every member of a parallel slot before carrying anything out of it', () => {
    const track = [
      step('reviewer', 'done', { group: 'review-wave' }),
      step('code-reviewer', 'running', { group: 'review-wave' }),
      step('final-audit', 'pending'),
    ];

    expect(states(track)[1], 'one member of the wave is still out').toBe('idle');
  });

  it('reaches back past a step the run was free to skip, instead of cutting the track', () => {
    const links = buildLinks(toColumns([
      step('planner', 'done'),
      step('optimizer-cleanup', 'pending', { conditional: true }),
      step('validator', 'running'),
    ]));

    expect(links[1]?.state, 'a skipped slot passes the report straight through').toBe('carried');
    expect(columnLabel(links[2]!.from), 'the validator got its input from the planner').toBe('planner');
    expect(links[2]?.state).toBe('flowing');
  });

  it('names both ends of a link, a parallel slot by all of its steps', () => {
    const columns = toColumns([
      entry(agent('reviewer', 'Reviewer', 'review-wave')),
      entry(agent('code-reviewer', 'Code review', 'review-wave')),
      entry(agent('final-audit', 'Final audit')),
    ]);

    expect(columnLabel(columns[0])).toBe('Reviewer + Code review');
    expect(buildLinks(columns)[1]?.to.key).toBe('final-audit');
  });
});

describe('resolveSelection', () => {
  it('resolves an open selection to its own step while that step is on the track', () => {
    const run = mkRun([ran('planner', 'planner'), ran('implementer', 'implementer')]);

    expect(resolveSelection(run, { kind: 'step', id: 'planner', role: 'planner' })?.key).toBe('planner');
    expect(resolveSelection(run, null)).toBeUndefined();
  });

  it('carries the open selection to the step the same role owns after the track swaps', () => {
    const run = mkRun([ran('implementer', 'implementer'), ran('optimizer-cleanup', 'optimizer')]);
    const carried = resolveSelection(run, { kind: 'step', id: 'optimizer-phase2', role: 'optimizer' });

    expect(carried?.key, 'the wave step left the track, its optimizer run did not').toBe('optimizer-cleanup');
    expect(carried?.agents).toHaveLength(1);
  });

  it('drops the selection only when no step of that role is left holding a run', () => {
    const run = mkRun([ran('implementer', 'implementer')]);

    expect(resolveSelection(run, { kind: 'step', id: 'reviewer', role: 'reviewer' })).toBeUndefined();
  });

  it('resolves an off-track selection to every agent of that type', () => {
    const first = mk('general-purpose', 'completed');
    const second = mk('general-purpose', 'running');
    const run = mkRun([], [first, mk('security-review', 'completed'), second]);
    const selected = resolveSelection(run, { kind: 'offTrack', type: 'general-purpose' });

    expect(selected?.key).toBe(offTrackKey('general-purpose'));
    expect(selected?.agents.map((item) => item.id)).toEqual([first.id, second.id]);
  });
});

describe('groupOffTrack', () => {
  it('collapses repeated runs of one type into a single entry that counts them', () => {
    const groups = groupOffTrack([
      mk('general-purpose', 'completed'),
      mk('security-review', 'completed'),
      mk('general-purpose', 'completed'),
    ]);

    expect(groups.map((group) => group.type)).toEqual(['general-purpose', 'security-review']);
    expect(groups[0].agents).toHaveLength(2);
  });

  it('reads the group as running while any of its runs is still live', () => {
    const groups = groupOffTrack([mk('general-purpose', 'error'), mk('general-purpose', 'running')]);

    expect(groups[0].status, 'a relaunch in flight outranks the run that failed').toBe('running');
  });
});

describe('liveElapsedMs', () => {
  const LAUNCHED_AT = '2026-08-29T10:00:00.000Z';
  const NOW = Date.parse(LAUNCHED_AT) + 90_000;

  function slot(agents: SubagentInfo[], status: PipelineStepStatus = 'running'): StepRun {
    return { step: agent('implementer', 'Implementer'), status, agents };
  }

  it('counts from the launch timestamp of the one run a live step holds', () => {
    expect(liveElapsedMs(slot([mk('implementer', 'running', { startedAt: LAUNCHED_AT })]), NOW)).toBe(90_000);
  });

  it('reports nothing when the launching message left no timestamp to count from', () => {
    expect(liveElapsedMs(slot([mk('implementer', 'running')]), NOW)).toBeNull();
    expect(liveElapsedMs(slot([mk('implementer', 'running', { startedAt: 'launched recently' })]), NOW)).toBeNull();
  });

  it('reports nothing for a settled step, whose recorded duration is the real one', () => {
    const agents = [mk('implementer', 'completed', { startedAt: LAUNCHED_AT })];

    expect(liveElapsedMs(slot(agents, 'done'), NOW)).toBeNull();
    expect(liveElapsedMs(slot(agents, 'error'), NOW)).toBeNull();
    expect(liveElapsedMs(slot(agents, 'pending'), NOW)).toBeNull();
  });

  it('reports nothing for a slot holding several runs, where one count cannot describe the step', () => {
    expect(liveElapsedMs(slot([
      mk('implementer', 'completed', { startedAt: LAUNCHED_AT }),
      mk('implementer', 'running', { startedAt: LAUNCHED_AT }),
    ]), NOW)).toBeNull();
  });

  it('reports nothing rather than a countdown when the launch timestamp is ahead of now', () => {
    const started = slot([mk('implementer', 'running', { startedAt: LAUNCHED_AT })]);

    expect(liveElapsedMs(started, Date.parse(LAUNCHED_AT) - 5_000)).toBeNull();
  });
});

describe('summarizeRun', () => {
  it('counts a skipped conditional step as work the run never had, not work outstanding', () => {
    const summary = summarizeRun(derivePipelineRun(SKIPPED_CLEANUP_RUN));

    expect(summary.done, 'the cleanup pass, the wave optimizer and the closer never ran').toBe(summary.total);
    expect(summary.running).toEqual([]);
  });

  it('names the live steps and sums only what adds up across parallel agents', () => {
    const summary = summarizeRun(derivePipelineRun([
      mk('planner', 'completed', { totalTokens: 1_000, totalToolUseCount: 4, totalDurationMs: 60_000 }),
      mk('implementer', 'running', { totalTokens: 500, totalToolUseCount: 2, totalDurationMs: 30_000 }),
      mk('general-purpose', 'completed', { totalTokens: 20, totalToolUseCount: 1 }),
    ]));

    expect(summary.running).toEqual(['Implementer']);
    expect(summary.totalTokens, 'off-track agents cost the run too').toBe(1_520);
    expect(summary.totalToolUseCount).toBe(7);
    expect(summary, 'agents run in parallel, so a summed wall-clock would misreport the run')
      .not.toHaveProperty('totalDurationMs');
  });
});
