import { beforeEach, describe, expect, it } from 'vitest';
import type { SubagentInfo, SubagentStatus } from '../../types';
import { blockBefore, derivePipelineRun } from './derivePipelineRun';
import { PIPELINE_TRACKS } from './pipelineDescriptor';

type TrackMode = keyof typeof PIPELINE_TRACKS;

let sequence = 0;

// The steps the pipeline contract lets a run skip outright, listed here rather than
// read off the descriptor, so a descriptor that forgets a flag fails this spec
// instead of mirroring itself. PIPELINE.md: 306 (Full entered without a triage
// probe), 377 (cleanup pass), 305/555 (the wave optimizer runs only if the cleanup
// pass was not skipped).
const SKIPPABLE_STEPS: Record<TrackMode, string[]> = {
  fast: ['optimizer-cleanup', 'closer'],
  standard: ['triage', 'optimizer-cleanup', 'optimizer-phase2', 'closer'],
  full: ['triage', 'ux-analyst', 'test-engineer', 'optimizer-cleanup', 'optimizer-phase2', 'closer'],
};

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

describe('derivePipelineRun', () => {
  beforeEach(() => {
    sequence = 0;
  });

  it('infers full when a perspective agent ran', () => {
    const run = derivePipelineRun([
      mk('triage', 'completed'),
      mk('ux-analyst', 'completed'),
      mk('tech-architect', 'completed'),
    ]);

    expect(run.mode).toBe('full');
  });

  it('does not read a branch-scale lens review as a Full run', () => {
    const run = derivePipelineRun([
      mk('risk-analyst', 'completed'),
      mk('code-reviewer', 'running'),
    ]);

    expect(run.mode, 'the risk analyst also authors the lens set outside the pipeline').toBe('none');
  });

  it('draws no track for a run whose agents belong to no pipeline path', () => {
    const lens = mk('risk-analyst', 'completed');
    const review = mk('code-reviewer', 'running');
    const run = derivePipelineRun([lens, review]);

    expect(run.steps, 'a forced track would show steps this run never had').toEqual([]);
    expect(run.offTrack.map((agent) => agent.id)).toEqual([lens.id, review.id]);
  });

  it('draws the track the reader picked instead of the detected one', () => {
    const agents = [mk('planner', 'completed'), mk('implementer', 'running')];
    const run = derivePipelineRun(agents, 'full');

    expect(run.mode).toBe('full');
    expect(run.detectedMode, 'the pick does not rewrite what the agents say').toBe('standard');
    expect(run.steps.map((entry) => entry.step.id)).toEqual(PIPELINE_TRACKS.full.map((step) => step.id));
    expect(run.steps.find((entry) => entry.step.id === 'implementer')?.agents).toHaveLength(1);
  });

  it('a picked track gives a run outside every path somewhere to be drawn', () => {
    const run = derivePipelineRun([mk('code-reviewer', 'completed')], 'fast');

    expect(run.detectedMode).toBe('none');
    expect(run.steps.find((entry) => entry.step.id === 'code-reviewer')?.status).toBe('done');
  });

  it('infers full when the risk analyst ran beside a role only Full launches', () => {
    const run = derivePipelineRun([
      mk('tech-architect', 'completed'),
      mk('risk-analyst', 'completed'),
    ]);

    expect(run.mode).toBe('full');
  });

  it('infers standard when planner ran without perspectives, with triage on the track', () => {
    const triage = mk('triage', 'completed');
    const run = derivePipelineRun([triage, mk('planner', 'completed')]);
    const triageStep = run.steps.find((entry) => entry.step.role === 'triage');

    expect(run.mode).toBe('standard');
    expect(triageStep?.agents.map((agent) => agent.id)).toEqual([triage.id]);
    expect(triageStep?.status).toBe('done');
    expect(run.offTrack).toHaveLength(0);
  });

  it('infers fast when implementer ran without planner', () => {
    const run = derivePipelineRun([
      mk('triage', 'completed'),
      mk('implementer', 'running'),
    ]);

    expect(run.mode).toBe('fast');
  });

  it('returns undetermined and renders the standard track when only triage has run', () => {
    const triage = mk('triage', 'running');
    const run = derivePipelineRun([triage]);
    const triageStep = run.steps.find((entry) => entry.step.role === 'triage');

    expect(run.mode).toBe('undetermined');
    expect(run.steps.map((entry) => entry.step.id)).toEqual(PIPELINE_TRACKS.standard.map((step) => step.id));
    expect(triageStep?.agents.map((agent) => agent.id)).toEqual([triage.id]);
    expect(triageStep?.status).toBe('running');
    expect(run.offTrack).toHaveLength(0);
  });

  it('step status follows its subagents', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('validator', 'error'),
      mk('code-reviewer', 'running'),
    ]);
    const statusOf = (role: string) => run.steps.find((entry) => entry.step.role === role)?.status;

    expect(statusOf('planner')).toBe('done');
    expect(statusOf('validator')).toBe('error');
    expect(statusOf('code-reviewer'), 'no later step holds an agent, so this one is still live').toBe('running');
  });

  it('a step relaunched after an error reads as running, not failed', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'error'),
      mk('implementer', 'running'),
    ]);
    const implementer = run.steps.find((entry) => entry.step.id === 'implementer');

    expect(implementer?.agents).toHaveLength(2);
    expect(implementer?.status, 'the relaunch is live, the failed run is history').toBe('running');
  });

  it('descriptor steps with no subagent stay pending', () => {
    const run = derivePipelineRun([mk('planner', 'completed')]);
    const pending = run.steps.filter((entry) => entry.status === 'pending');

    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((entry) => entry.agents.length === 0)).toBe(true);
  });

  it('two optimizer runs fill the cleanup step then the review-wave step, in messageIndex order', () => {
    const planner = mk('planner', 'completed');
    const cleanupRun = mk('optimizer', 'completed');
    const reviewWaveRun = mk('optimizer', 'running');
    // Shuffled input: assignment must follow messageIndex, not array order.
    const run = derivePipelineRun([reviewWaveRun, planner, cleanupRun]);
    const optimizerSteps = run.steps.filter((entry) => entry.step.role === 'optimizer');

    expect(optimizerSteps).toHaveLength(2);
    expect(optimizerSteps[0].agents.map((agent) => agent.id)).toEqual([cleanupRun.id]);
    expect(optimizerSteps[1].agents.map((agent) => agent.id)).toEqual([reviewWaveRun.id]);
    expect(optimizerSteps[0].status).toBe('done');
    expect(optimizerSteps[1].status).toBe('running');
  });

  it('an unknown subagent_type lands in offTrack instead of being dropped', () => {
    const stray = mk('general-purpose', 'completed');
    const run = derivePipelineRun([mk('planner', 'completed'), stray]);

    expect(run.offTrack.map((agent) => agent.id)).toContain(stray.id);
  });

  it('the track-opening orchestrator step waits until the run produced any evidence', () => {
    const idle = derivePipelineRun([]);
    const started = derivePipelineRun([mk('planner', 'running')]);

    expect(idle.steps[0].step.kind).toBe('orchestrator');
    expect(idle.steps[0].step.role).toBeUndefined();
    expect(idle.steps[0].status, 'no agent ran, so no pipeline reached the board').toBe('pending');
    expect(started.steps[0].status).toBe('done');
  });

  it('an agent outside the track is evidence enough for the opening step', () => {
    const run = derivePipelineRun([mk('general-purpose', 'completed')], 'standard');

    expect(run.offTrack).toHaveLength(1);
    expect(run.steps[0].status).toBe('done');
  });

  it('a trailing orchestrator step stays pending while the run has not reached it', () => {
    const run = derivePipelineRun([mk('planner', 'completed'), mk('implementer', 'running')]);
    const finalAudit = run.steps.find((entry) => entry.step.id === 'final-audit');

    expect(finalAudit?.status).toBe('pending');
  });

  it('a trailing orchestrator step turns done once its predecessor finishes', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('optimizer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'completed'),
      mk('code-reviewer', 'completed'),
      mk('optimizer', 'completed'),
    ]);
    const finalAuditIndex = run.steps.findIndex((entry) => entry.step.id === 'final-audit');

    expect(run.steps[finalAuditIndex - 1].status).toBe('done');
    expect(run.steps[finalAuditIndex].status).toBe('done');
  });

  it('an unfinished predecessor holds the trailing orchestrator step back even when later agents have run', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('optimizer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'completed'),
      mk('code-reviewer', 'completed'),
      mk('optimizer', 'running'),
    ]);
    const finalAudit = run.steps.find((entry) => entry.step.id === 'final-audit');

    expect(finalAudit?.status).toBe('pending');
  });

  it('a parallel group holds the next orchestrator step until every member finishes, not only the last-listed one', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('optimizer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'running'),
      mk('code-reviewer', 'running'),
      mk('optimizer', 'completed'),
    ]);
    const statusOf = (id: string) => run.steps.find((entry) => entry.step.id === id)?.status;

    expect(statusOf('optimizer-phase2'), 'the member listed last happened to finish first').toBe('done');
    expect(statusOf('reviewer')).toBe('running');
    expect(statusOf('code-reviewer')).toBe('running');
    expect(statusOf('final-audit'), 'two wave members are still running, so the audit is unreached').toBe('pending');
  });

  it('a skipped cleanup pass does not freeze the audit once the review wave is through', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'completed'),
      mk('code-reviewer', 'completed'),
    ]);
    const statusOf = (id: string) => run.steps.find((entry) => entry.step.id === id)?.status;

    expect(statusOf('optimizer-cleanup'), 'the diff was mechanical, no optimizer ran').toBe('pending');
    expect(statusOf('optimizer-phase2'), 'the wave optimizer follows the cleanup pass').toBe('pending');
    expect(statusOf('final-audit'), 'the wave is through, so the audit was reached').toBe('done');
  });

  it('a running review wave still holds the audit back when the optimizer was skipped', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'running'),
      mk('code-reviewer', 'completed'),
    ]);

    expect(run.steps.find((entry) => entry.step.id === 'final-audit')?.status).toBe('pending');
  });

  it('a step the run walked past is stalled, not running', () => {
    const lost = mk('implementer', 'running');
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      lost,
      mk('validator', 'completed'),
    ]);
    const statusOf = (id: string) => run.steps.find((entry) => entry.step.id === id)?.status;

    expect(statusOf('implementer'), 'the validator already answered, so nothing is still working').toBe('stalled');
    expect(run.stalledAgentIds).toEqual([lost.id]);
  });

  it('a live wave member is not stalled by the sibling that finished before it', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'running'),
      mk('code-reviewer', 'running'),
      mk('optimizer', 'completed'),
    ]);
    const statusOf = (id: string) => run.steps.find((entry) => entry.step.id === id)?.status;

    expect(statusOf('reviewer'), 'wave members finish in any order').toBe('running');
    expect(statusOf('code-reviewer')).toBe('running');
    expect(run.stalledAgentIds).toEqual([]);
  });

  it('the last step of a run is left running: nothing proves it stopped', () => {
    const run = derivePipelineRun([mk('planner', 'completed'), mk('implementer', 'running')]);

    expect(run.steps.find((entry) => entry.step.id === 'implementer')?.status).toBe('running');
    expect(run.stalledAgentIds).toEqual([]);
  });

  it('a relaunch that reported back settles the step its stalled run left open', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'running'),
      mk('implementer', 'completed'),
      mk('validator', 'completed'),
    ]);
    const implementer = run.steps.find((entry) => entry.step.id === 'implementer');

    expect(implementer?.agents).toHaveLength(2);
    expect(implementer?.status, 'the relaunch answered, so the step is not a dead end').toBe('done');
  });

  it('an orchestrator step waiting on a stalled one is a dead end, not pending', () => {
    const run = derivePipelineRun([
      mk('planner', 'completed'),
      mk('implementer', 'completed'),
      mk('validator', 'completed'),
      mk('reviewer', 'running'),
      mk('code-reviewer', 'completed'),
      mk('closer', 'completed'),
    ]);
    const statusOf = (id: string) => run.steps.find((entry) => entry.step.id === id)?.status;

    expect(statusOf('reviewer'), 'the closer ran, so the wave is over').toBe('stalled');
    expect(statusOf('final-audit'), 'a step that waits on one that never reports is not waiting').toBe('stalled');
  });

  it('every step the contract lets a run skip carries the conditional flag', () => {
    for (const [mode, track] of Object.entries(PIPELINE_TRACKS)) {
      const flagged = track.filter((step) => step.conditional).map((step) => step.id).sort();

      expect(flagged, `${mode}: descriptor flags`).toEqual([...SKIPPABLE_STEPS[mode as TrackMode]].sort());
    }
  });

  // Guards the predecessor rule against the descriptor: an unflagged skippable step
  // in the block would pin the orchestrator step after it for the whole run.
  it('no orchestrator step waits on a skippable step that the descriptor left unflagged', () => {
    for (const [mode, track] of Object.entries(PIPELINE_TRACKS)) {
      track.forEach((step, index) => {
        if (step.kind !== 'orchestrator') return;
        const unflagged = blockBefore(track, index)
          .filter((entry) => SKIPPABLE_STEPS[mode as TrackMode].includes(entry.id))
          .find((entry) => !entry.conditional);

        expect(
          unflagged?.id,
          `${mode}: ${step.id} would freeze whenever ${unflagged?.id} is skipped`,
        ).toBeUndefined();
      });
    }
  });
});
