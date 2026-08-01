import { describe, expect, it } from 'vitest';
import {
  finalizeSubagentsForSettledTurn,
  findConversationTurnStarts,
  resolveStatusScopeStart,
} from './turnScope';
import type { ClaudeMessage, SubagentInfo } from '../types';

const subagent = (overrides: Partial<SubagentInfo>): SubagentInfo => ({
  id: 'tu_1',
  type: 'research',
  description: 'task',
  status: 'running',
  messageIndex: 0,
  ...overrides,
});

describe('finalizeSubagentsForSettledTurn', () => {
  it('does not infer async completion from a settled main turn', () => {
    const result = finalizeSubagentsForSettledTurn([subagent({ isAsync: true })], false);
    expect(result[0].status).toBe('running');
  });

  it('preserves terminal status supplied by task_notification or sidechain history', () => {
    const result = finalizeSubagentsForSettledTurn(
      [
        subagent({ isAsync: true, status: 'completed' }),
        subagent({ isAsync: true, status: 'error' }),
      ],
      false,
    );
    expect(result.map((item) => item.status)).toEqual(['completed', 'error']);
  });

  it('does not mutate sync extraction results', () => {
    const running = subagent({ isAsync: false });
    const completed = subagent({ isAsync: false, status: 'completed' });
    const result = finalizeSubagentsForSettledTurn([running, completed], false);
    expect(result).toEqual([running, completed]);
  });

  it('returns the same states while streaming', () => {
    const result = finalizeSubagentsForSettledTurn(
      [subagent({ isAsync: false }), subagent({ isAsync: true })],
      true,
    );
    expect(result[0].status).toBe('running');
    expect(result[1].status).toBe('running');
  });
});

describe('findConversationTurnStarts', () => {
  const user = (content: string): ClaudeMessage => ({ type: 'user', content });
  const assistant = (): ClaudeMessage => ({ type: 'assistant', content: 'ok' });
  const toolResultUser = (): ClaudeMessage => ({ type: 'user', content: '[tool_result]' });

  it('collects every real user message index', () => {
    expect(findConversationTurnStarts([
      user('first'),
      assistant(),
      toolResultUser(),
      assistant(),
      user('second'),
      assistant(),
    ])).toEqual([0, 4]);
  });

  it('returns an empty list when there is no user message', () => {
    expect(findConversationTurnStarts([assistant()])).toEqual([]);
  });
});

describe('resolveStatusScopeStart', () => {
  const turnStarts = [0, 4, 9];

  it('keeps the latest turn when nothing earlier is still running', () => {
    const subagents = [
      subagent({ id: 'a', messageIndex: 5, status: 'completed' }),
      subagent({ id: 'b', messageIndex: 10, status: 'running' }),
    ];
    expect(resolveStatusScopeStart(subagents, turnStarts, 9)).toBe(9);
  });

  it('pulls the scope back to the turn that owns a still-running subagent', () => {
    const subagents = [
      subagent({ id: 'a', messageIndex: 5, status: 'running' }),
    ];
    expect(resolveStatusScopeStart(subagents, turnStarts, 9)).toBe(4);
  });

  it('keeps the running agent\'s finished siblings so progress counts stay honest', () => {
    const subagents = [
      subagent({ id: 'done-1', messageIndex: 5, status: 'completed' }),
      subagent({ id: 'done-2', messageIndex: 6, status: 'completed' }),
      subagent({ id: 'live', messageIndex: 7, status: 'running' }),
    ];
    const scopeStart = resolveStatusScopeStart(subagents, turnStarts, 9);
    expect(scopeStart).toBe(4);
    expect(subagents.filter((item) => item.messageIndex >= scopeStart)).toHaveLength(3);
  });

  it('walks back across several turns to the earliest unfinished one', () => {
    const subagents = [
      subagent({ id: 'old', messageIndex: 1, status: 'running' }),
      subagent({ id: 'recent', messageIndex: 5, status: 'running' }),
    ];
    expect(resolveStatusScopeStart(subagents, turnStarts, 9)).toBe(0);
  });

  it('never narrows when the latest turn starts the transcript', () => {
    expect(resolveStatusScopeStart([], [0], 0)).toBe(0);
    expect(resolveStatusScopeStart([], [], -1)).toBe(0);
  });

  it('ignores errored and completed agents from earlier turns', () => {
    const subagents = [
      subagent({ id: 'a', messageIndex: 5, status: 'error' }),
      subagent({ id: 'b', messageIndex: 6, status: 'completed' }),
    ];
    expect(resolveStatusScopeStart(subagents, turnStarts, 9)).toBe(9);
  });
});
