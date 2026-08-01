import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import { sliceLatestConversationTurn } from '../utils/turnScope';
import { deriveStatusPanelTodos, deriveTodosForTurn } from './useChatComputations';

interface TestMessage extends ClaudeMessage {
  __blocks?: ClaudeContentBlock[];
}

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
  (message as TestMessage).__blocks ?? [];

const user = (content: string): ClaudeMessage => ({ type: 'user', content });

const assistant = (blocks: ClaudeContentBlock[]): ClaudeMessage =>
  ({ type: 'assistant', __blocks: blocks }) as TestMessage;

const toolUse = (id: string, name: string, input: Record<string, unknown>): ClaudeContentBlock =>
  ({ type: 'tool_use', id, name, input });

describe('deriveTodosForTurn', () => {
  it('does not carry a completed plan into a new user turn', () => {
    const messages = [
      user('previous request'),
      assistant([
        toolUse('plan-1', 'update_plan', {
          plan: Array.from({ length: 5 }, (_, index) => ({
            step: `Previous step ${index + 1}`,
            status: 'completed',
          })),
        }),
      ]),
      user('Only answer OK'),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true)).toEqual([]);
  });

  it('shows the latest plan created in the current turn', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('old-plan', 'update_plan', {
        plan: [{ step: 'Old step', status: 'completed' }],
      })]),
      user('new request'),
      assistant([toolUse('new-plan', 'update_plan', {
        plan: [
          { step: 'First', status: 'in_progress' },
          { step: 'Second', status: 'pending' },
          { step: 'Third', status: 'pending' },
        ],
      })]),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true)).toEqual([
      { content: 'First', status: 'in_progress' },
      { content: 'Second', status: 'pending' },
      { content: 'Third', status: 'pending' },
    ]);
  });

  it('does not carry completed structured tasks into a new user turn', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('task-create-1', 'TaskCreate', { subject: 'Previous task' })]),
      {
        type: 'user',
        raw: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-create-1',
            content: 'Task #1 created successfully',
          }],
        },
      } as ClaudeMessage,
      assistant([toolUse('task-update-1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      user('Only answer OK'),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true)).toEqual([]);
  });

  it('keeps earlier todos when the full transcript is scoped (settled history replay)', () => {
    // Non-streaming scope feeds the WHOLE transcript to deriveTodosForTurn, so an
    // earlier turn's plan survives even when the last turn has no task tool —
    // exactly what a resumed history session needs to render its task list.
    const messages = [
      user('previous request'),
      assistant([toolUse('old-plan', 'update_plan', {
        plan: [
          { step: 'Kept step', status: 'completed' },
          { step: 'In-flight step', status: 'in_progress' },
        ],
      })]),
      user('Only answer OK'),
    ];

    expect(deriveTodosForTurn(messages, getContentBlocks, false)).toEqual([
      { content: 'Kept step', status: 'completed' },
      { content: 'In-flight step', status: 'completed' },
    ]);
  });
});

describe('deriveStatusPanelTodos', () => {
  // A run stopped mid-plan and resumed: the resumed turn works the existing
  // plan instead of rewriting it, so its own slice carries no todos.
  const interruptedThenResumed = [
    user('build the thing'),
    assistant([toolUse('plan-1', 'update_plan', {
      plan: [
        { step: 'Done step', status: 'completed' },
        { step: 'Live step', status: 'in_progress' },
        { step: 'Queued step', status: 'pending' },
      ],
    })]),
    user('continue'),
    assistant([toolUse('read-1', 'Read', { file_path: 'a.ts' })]),
  ];

  it('carries an unfinished plan into the resumed turn', () => {
    const scoped = sliceLatestConversationTurn(interruptedThenResumed);
    expect(deriveStatusPanelTodos(scoped, interruptedThenResumed, getContentBlocks, true, true)).toEqual([
      { content: 'Done step', status: 'completed' },
      { content: 'Live step', status: 'in_progress' },
      { content: 'Queued step', status: 'pending' },
    ]);
  });

  it('does not carry a fully completed plan into a new request', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('plan-1', 'update_plan', {
        plan: [{ step: 'All done', status: 'completed' }],
      })]),
      user('something else'),
      assistant([toolUse('read-1', 'Read', { file_path: 'a.ts' })]),
    ];

    const scoped = sliceLatestConversationTurn(messages);
    expect(deriveStatusPanelTodos(scoped, messages, getContentBlocks, true, true)).toEqual([]);
  });

  it('prefers the plan the current turn wrote itself', () => {
    const messages = [
      ...interruptedThenResumed,
      assistant([toolUse('plan-2', 'update_plan', {
        plan: [{ step: 'Fresh step', status: 'in_progress' }],
      })]),
    ];

    const scoped = sliceLatestConversationTurn(messages);
    expect(deriveStatusPanelTodos(scoped, messages, getContentBlocks, true, true)).toEqual([
      { content: 'Fresh step', status: 'in_progress' },
    ]);
  });

  it('does not carry anything over when the scope is not narrowed', () => {
    // Settled scope already spans the whole transcript, so the fallback must
    // stay out of the way and let the plain derivation stand.
    const scoped = interruptedThenResumed;
    expect(deriveStatusPanelTodos(scoped, interruptedThenResumed, getContentBlocks, false, false)).toEqual([
      { content: 'Done step', status: 'completed' },
      { content: 'Live step', status: 'completed' },
      { content: 'Queued step', status: 'pending' },
    ]);
  });
});
