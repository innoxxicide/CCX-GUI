import { describe, expect, it } from 'vitest';
import type { SubagentHistoryResponse, SubagentInfo, SubagentStatus } from '../../types';
import type { StepRun, PipelineStepStatus } from './derivePipelineRun';
import { buildStepActivities, historyOf } from './stepActivity';

function mk(id: string, status: SubagentStatus, extra?: Partial<SubagentInfo>): SubagentInfo {
  return { id, type: 'implementer', description: 'implementer run', status, messageIndex: 1, ...extra };
}

function slot(status: PipelineStepStatus, agents: SubagentInfo[]): StepRun {
  return { step: { id: 'implementer', label: 'Implementer', role: 'implementer', kind: 'agent' }, status, agents };
}

function transcript(...blocks: unknown[]): SubagentHistoryResponse {
  return {
    success: true,
    messages: blocks.map((content) => ({ type: 'assistant', message: { content: [content] } })),
  };
}

const text = (value: string) => ({ type: 'text', text: value });
const thinking = (value: string) => ({ type: 'thinking', thinking: value });
const toolUse = (name: string, input?: Record<string, unknown>) => ({ type: 'tool_use', name, input });

function activityOf(entry: StepRun, histories: Record<string, SubagentHistoryResponse>) {
  return buildStepActivities([entry], histories).get(entry.step.id);
}

describe('buildStepActivities', () => {
  it('shows the last heading a live agent wrote, which is the phase it reached', () => {
    const activity = activityOf(slot('running', [mk('tu-1', 'running')]), {
      'tu-1': transcript(
        text('## Phase 1 — reproduce\nWrote the failing test.'),
        toolUse('Bash', { command: 'npm test' }),
        text('### Phase 2 — root cause\nThe guard runs before the parse.'),
      ),
    });

    expect(activity?.kind).toBe('phase');
    expect(activity?.text).toBe('Phase 2 — root cause');
  });

  it('falls back to the tool it reached for while it has written no heading', () => {
    const activity = activityOf(slot('running', [mk('tu-1', 'running')]), {
      'tu-1': transcript(text('Let me look at the wall selector.'), toolUse('Read', { file_path: '/repo/src/Wall.cs' })),
    });

    expect(activity?.kind).toBe('tool');
    expect(activity?.text).toBe('Read · /repo/src/Wall.cs');
  });

  it('prefers a heading the agent wrote over one it only thought about', () => {
    const activity = activityOf(slot('running', [mk('tu-1', 'running')]), {
      'tu-1': transcript(
        text('## Phase 3 — apply the fix'),
        thinking('## Rewrite everything\nMaybe the whole module should go.'),
      ),
    });

    expect(activity?.text, 'a phase considered in reasoning is not a phase the run entered').toBe('Phase 3 — apply the fix');
  });

  it('reads a phase out of reasoning when the agent has written nothing yet', () => {
    const activity = activityOf(slot('running', [mk('tu-1', 'running')]), {
      'tu-1': transcript(thinking('**Step 2: check the callers**\nThe helper has three of them.')),
    });

    expect(activity?.text).toBe('Step 2: check the callers');
  });

  it('shows what a settled step handed on, taken from its report', () => {
    const activity = activityOf(
      slot('done', [mk('tu-1', 'completed', { resultText: '\nPlan ready: 4 steps, no new files.\nDetails below.' })]),
      {},
    );

    expect(activity?.kind).toBe('handoff');
    expect(activity?.text).toBe('Plan ready: 4 steps, no new files.');
  });

  it('falls back to the transcript when an interrupted run lost its report', () => {
    const activity = activityOf(slot('stalled', [mk('tu-1', 'running')]), {
      'tu-1': transcript(text('```json\n{"findings": []}\n```\nNo findings survived verification.')),
    });

    expect(activity?.text, 'a fenced block has no sentence to quote').toBe('No findings survived verification.');
  });

  it('shows a stalled step the phase it died in rather than its last words', () => {
    const activity = activityOf(slot('stalled', [mk('tu-1', 'running')]), {
      'tu-1': transcript(text('## Phase 4 — verify\nRunning the suite now.')),
    });

    expect(activity?.kind).toBe('phase');
    expect(activity?.text).toBe('Phase 4 — verify');
  });

  it('says nothing for a slot holding several runs, where one line cannot describe the step', () => {
    const entry = slot('running', [mk('tu-1', 'running'), mk('tu-2', 'running')]);

    expect(activityOf(entry, { 'tu-1': transcript(text('## Phase 1')) })).toBeUndefined();
  });

  it('says nothing while the transcript of a live agent has not arrived', () => {
    expect(activityOf(slot('running', [mk('tu-1', 'running')]), {})).toBeUndefined();
    expect(activityOf(slot('running', [mk('tu-1', 'running')]), { 'tu-1': { success: false } })).toBeUndefined();
  });

  it('mistakes ordinary prose for neither a heading nor a phase', () => {
    const activity = activityOf(slot('running', [mk('tu-1', 'running')]), {
      'tu-1': transcript(text('Step back and look at the whole flow before changing it.'), toolUse('Grep')),
    });

    expect(activity?.kind).toBe('tool');
    expect(activity?.text).toBe('Grep');
  });
});

describe('historyOf', () => {
  it('finds the transcript under the tool-use id, and under the runtime agent id after it lands', () => {
    const byToolUse: SubagentHistoryResponse = { success: true, messages: [] };
    const byAgent: SubagentHistoryResponse = { success: true, messages: [], agentId: 'agent-9' };

    expect(historyOf(mk('tu-1', 'running'), { 'tu-1': byToolUse })).toBe(byToolUse);
    expect(historyOf(mk('tu-1', 'running', { agentId: 'agent-9' }), { 'agent-9': byAgent })).toBe(byAgent);
    expect(historyOf(mk('tu-1', 'running'), {})).toBeUndefined();
  });
});
