/**
 * `undetermined` — a pipeline run whose route is not settled yet.
 * `none` — agents ran, but none of them belongs to a pipeline track (a branch-scale
 * lens review, an ad-hoc Explore batch); forcing a track on those draws a run that
 * never existed, with every step after the first permanently unreached.
 */
export type PipelineMode = 'fast' | 'standard' | 'full' | 'undetermined' | 'none';

/** The modes that own a track, and so can be picked by hand in the header. */
export type TrackMode = 'fast' | 'standard' | 'full';

export interface PipelineStep {
  id: string;
  label: string;
  /** Literal subagent_type of the agent that owns the step; absent for orchestrator-owned steps. */
  role?: string;
  kind: 'agent' | 'orchestrator';
  /** Runs only under a condition the pipeline decides per task (UI signal, TDD gate, explicit command). */
  conditional?: boolean;
  /** Steps sharing a group run in parallel and render stacked in one track column. */
  group?: string;
}

const FINAL_AUDIT: PipelineStep = { id: 'final-audit', label: 'Final audit', kind: 'orchestrator' };
const CLOSER: PipelineStep = { id: 'closer', label: 'Closer', role: 'closer', kind: 'agent', conditional: true };
const TASK_BOARD: PipelineStep = { id: 'task-board', label: 'Task board', kind: 'orchestrator' };

// The cleanup pass is skipped outright on a mechanical diff, and the review-wave
// optimizer runs only when it was not, so both optimizer steps can go missing on a
// perfectly healthy run.
function reviewWave(): PipelineStep[] {
  return [
    { id: 'reviewer', label: 'Reviewer', role: 'reviewer', kind: 'agent', group: 'review-wave' },
    { id: 'code-reviewer', label: 'Code review', role: 'code-reviewer', kind: 'agent', group: 'review-wave' },
    { id: 'optimizer-phase2', label: 'Optimizer · Phase 2', role: 'optimizer', kind: 'agent', conditional: true, group: 'review-wave' },
  ];
}

export const PIPELINE_TRACKS: Record<TrackMode, PipelineStep[]> = {
  fast: [
    TASK_BOARD,
    { id: 'triage', label: 'Triage', role: 'triage', kind: 'agent' },
    { id: 'implementer', label: 'Implementer', role: 'implementer', kind: 'agent' },
    { id: 'optimizer-cleanup', label: 'Cleanup pass · light', role: 'optimizer', kind: 'agent', conditional: true },
    { id: 'validator', label: 'Validator', role: 'validator', kind: 'agent' },
    { id: 'code-reviewer', label: 'Code review · low', role: 'code-reviewer', kind: 'agent' },
    FINAL_AUDIT,
    CLOSER,
  ],
  standard: [
    TASK_BOARD,
    // Runs only on the ambiguous route, where triage is the probe that chose Standard.
    { id: 'triage', label: 'Triage', role: 'triage', kind: 'agent', conditional: true },
    { id: 'planner', label: 'Planner', role: 'planner', kind: 'agent' },
    { id: 'implementer', label: 'Implementer', role: 'implementer', kind: 'agent' },
    { id: 'optimizer-cleanup', label: 'Cleanup pass', role: 'optimizer', kind: 'agent', conditional: true },
    { id: 'validator', label: 'Validator', role: 'validator', kind: 'agent' },
    ...reviewWave(),
    FINAL_AUDIT,
    CLOSER,
  ],
  full: [
    TASK_BOARD,
    // Full is also entered by a direct planner Full Routing Header, with no triage probe.
    { id: 'triage', label: 'Triage', role: 'triage', kind: 'agent', conditional: true },
    { id: 'ux-analyst', label: 'UX analyst', role: 'ux-analyst', kind: 'agent', conditional: true, group: 'perspectives' },
    { id: 'tech-architect', label: 'Tech architect', role: 'tech-architect', kind: 'agent', group: 'perspectives' },
    { id: 'risk-analyst', label: 'Risk analyst', role: 'risk-analyst', kind: 'agent', group: 'perspectives' },
    { id: 'planner', label: 'Planner', role: 'planner', kind: 'agent' },
    { id: 'test-engineer', label: 'Test engineer · RED', role: 'test-engineer', kind: 'agent', conditional: true },
    { id: 'implementer', label: 'Implementer', role: 'implementer', kind: 'agent' },
    { id: 'optimizer-cleanup', label: 'Cleanup pass', role: 'optimizer', kind: 'agent', conditional: true },
    { id: 'validator', label: 'Validator', role: 'validator', kind: 'agent' },
    ...reviewWave(),
    FINAL_AUDIT,
    CLOSER,
  ],
};
