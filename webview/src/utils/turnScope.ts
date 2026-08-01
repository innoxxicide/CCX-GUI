import type { ClaudeMessage, TodoItem, SubagentInfo } from '../types';

export function isToolResultOnlyUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if ((message.content ?? '').trim() === '[tool_result]') return true;

  const raw = message.raw;
  if (!raw || typeof raw === 'string') return false;

  const content = raw.content ?? raw.message?.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) =>
    block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result',
  );
}

export function findLatestConversationTurnStart(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (isToolResultOnlyUserMessage(message)) continue;
    return i;
  }
  return -1;
}

export function sliceLatestConversationTurn(messages: ClaudeMessage[]): ClaudeMessage[] {
  const start = findLatestConversationTurnStart(messages);
  return start >= 0 ? messages.slice(start) : [];
}

/**
 * Indices of every turn-starting user message, oldest first. tool_result-only
 * user messages are transport noise, not turn boundaries.
 */
export function findConversationTurnStarts(messages: ClaudeMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (isToolResultOnlyUserMessage(message)) continue;
    starts.push(i);
  }
  return starts;
}

/** Largest turn start at or before `messageIndex`, or 0 when there is none. */
function turnStartAtOrBefore(turnStarts: number[], messageIndex: number): number {
  let result = 0;
  for (const start of turnStarts) {
    if (start > messageIndex) break;
    result = start;
  }
  return result;
}

/**
 * Where the status panel's narrow (current-turn) scope must actually begin.
 *
 * A user message ends a *turn*, not the work that turn started: subagents
 * survive an interrupt and keep running into the next turn. Scoping strictly to
 * the latest turn therefore blanks the Tasks/Subagents tabs the moment an
 * interrupted run is resumed - precisely when their state matters most. So the
 * start is pulled back to the beginning of the earliest turn that still owns a
 * running subagent, which keeps that turn's already-finished agents too:
 * otherwise a group of 3 finished plus 2 running would report "0/2" instead of
 * "3/5".
 */
export function resolveStatusScopeStart(
  subagents: SubagentInfo[],
  turnStarts: number[],
  latestTurnStart: number,
): number {
  if (latestTurnStart <= 0) return 0;
  let scopeStart = latestTurnStart;
  for (const subagent of subagents) {
    if (subagent.status !== 'running') continue;
    if (subagent.messageIndex >= scopeStart) continue;
    const turnStart = turnStartAtOrBefore(turnStarts, subagent.messageIndex);
    if (turnStart < scopeStart) scopeStart = turnStart;
  }
  return scopeStart;
}

export function finalizeTodosForSettledTurn(todos: TodoItem[], isStreaming: boolean): TodoItem[] {
  if (isStreaming) return todos;
  return todos.map((todo) => (
    todo.status === 'in_progress'
      ? { ...todo, status: 'completed' }
      : todo
  ));
}

export function finalizeSubagentsForSettledTurn(subagents: SubagentInfo[], _isStreaming: boolean): SubagentInfo[] {
  // A settled main turn is not evidence that a run_in_background agent ended:
  // the launch turn completes while the sidechain may still be running. Async
  // agents are finalized only by task_notification or by a sidechain transcript
  // ending in assistant/end_turn (resolved in useSubagents). Sync agents already
  // derive their terminal state from the Agent tool_result.
  return subagents;
}
