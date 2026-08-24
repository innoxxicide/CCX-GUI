/**
 * Detection of "this turn stopped because the account ran out of quota".
 *
 * The CLI does NOT fail a turn when a usage limit is reached. It ends the turn
 * with a *synthetic* assistant message — `model: "<synthetic>"`,
 * `error: "rate_limit"`, `stop_reason: "stop_sequence"` — whose only content is
 * the limit notice, and the turn's `result` is an ordinary success. Two
 * consequences the rest of the pipeline used to fall for:
 *
 *   1. The synthetic message is text-only, so `shouldOutputMessage` suppresses
 *      its `[MESSAGE]` envelope in streaming mode — the `error: "rate_limit"`
 *      marker never reaches Java, and only the bare text lands in the chat
 *      bubble as if the agent had said it.
 *   2. No `[SEND_ERROR]` is emitted, so `ClaudeMessageHandler.onError` never
 *      runs: no red error card, and no `notifyTurnError` — which is what arms
 *      auto-resume-on-usage-limit.
 *
 * In multi-agent runs the same stop can also arrive without any main-line
 * assistant message at all: a subagent dies first and only its Task tool_result
 * ("Agent terminated early due to an API error: …") or a background agent's
 * `task_notification` carries the notice.
 *
 * This module is the single place that recognizes all of those shapes. It is
 * pure — callers decide what to do with a detection.
 */

import { truncateString } from './message-output-filter.js';

/**
 * Prefixes of messages that mean "a usage limit was genuinely reached".
 *
 * Mirrors the SDK's `USAGE_LIMIT_ERROR_PREFIXES` export (@alpha, so not
 * imported: the SDK is installed on demand and the constant may move). Deliberately
 * excludes the SDK's warning ("You've used …", "You're close to …") and
 * overage-transition ("You're now using …") buckets — those do not stop a turn.
 */
export const USAGE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "You're out of extra usage",
  'Your org is out of usage',
  "Your seat type doesn't include usage",
  "Your seat type doesn't include extra usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  // Legacy CLI wording, still emitted by older Claude Code builds:
  // "Claude AI usage limit reached|1764512400"
  'Claude AI usage limit reached'
];

/**
 * How a subagent failure is reported to its parent — both in the Task tool_result
 * and in a background agent's task_notification summary. The limit notice follows.
 */
const AGENT_ABORT_MARKER = 'Agent terminated early due to an API error:';

/** Legacy wording carries the reset time as a `|<epoch-seconds>` suffix. */
const LEGACY_EPOCH_SUFFIX = /Claude AI usage limit reached\|(\d{9,13})/;

/**
 * Whether a line of text is a usage-limit notice.
 *
 * Matched anywhere in the text, not just at position 0: the same notice is
 * embedded mid-string in subagent tool_results and task_notification summaries.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isUsageLimitText(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.includes(prefix));
}

/**
 * Pull just the limit notice out of a longer message, so the error surfaced to
 * the user is the notice itself rather than a wall of recovered partial output.
 *
 * @param {string} text
 * @returns {string|null} the notice, or null when the text carries none
 */
export function extractUsageLimitText(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const marker = text.indexOf(AGENT_ABORT_MARKER);
  const searchFrom = marker >= 0 ? text.slice(marker + AGENT_ABORT_MARKER.length) : text;
  for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
    const at = searchFrom.indexOf(prefix);
    if (at < 0) continue;
    // The notice is one line ("You've hit your session limit · resets 3pm (Europe/Kiev)");
    // everything after the newline is recovered partial output or SDK boilerplate.
    const rest = searchFrom.slice(at);
    const newline = rest.indexOf('\n');
    return (newline >= 0 ? rest.slice(0, newline) : rest).trim();
  }
  return null;
}

/**
 * Normalize an epoch that may be expressed in seconds or milliseconds.
 * 10-digit values are seconds, 13-digit are millis.
 */
function toEpochMs(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 100_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
}

/** Reset time carried inline by the legacy `…|<epoch>` wording, else 0. */
function resetsAtFromText(text) {
  const match = typeof text === 'string' ? text.match(LEGACY_EPOCH_SUFFIX) : null;
  return match ? toEpochMs(match[1]) : 0;
}

/** Concatenate the text blocks of an assistant SDK message. */
function collectText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Concatenate only the tool_result payloads of a user message.
 *
 * Deliberately excludes the message's own text blocks: a user asking about a
 * limit notice — or pasting a transcript that contains one — must never be read
 * as the limit itself.
 */
function collectToolResultText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    if (typeof block.content === 'string') {
      parts.push(block.content);
    } else if (Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Whether an assistant message is one of Claude Code's synthetic API-error
 * messages rather than real model output.
 *
 * The notice text alone cannot decide this — the model can quote a limit notice
 * while discussing one, and acting on that would fabricate an error and suppress
 * a legitimate answer. Every synthetic message carries at least one of these
 * markers, and a genuine model turn carries none.
 */
function isSyntheticApiErrorMessage(msg) {
  return (typeof msg.error === 'string' && msg.error.length > 0)
    || msg.isApiErrorMessage === true
    || msg.message?.model === '<synthetic>';
}

/**
 * Classify one SDK message.
 *
 * @param {object} msg - a raw SDK message from the query iterator
 * @returns {null | {
 *   text: string,
 *   resetsAt: number,
 *   source: 'assistant'|'rate_limit_event'|'tool_result'|'task_notification'|'result',
 *   sidechain: boolean,
 *   sticky: boolean
 * }}
 *   `sticky` marks a signal that is terminal on its own; a non-sticky signal
 *   (a bare `rate_limit_event`) can still be superseded by later successful
 *   output in the same turn — the CLI emits one when it falls back from an
 *   exhausted per-model window to a model that is still allowed.
 */
export function detectUsageLimit(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const sidechain = msg.parent_tool_use_id != null;

  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info;
    if (!info || info.status !== 'rejected') return null;
    return {
      text: 'Claude usage limit reached.',
      resetsAt: toEpochMs(info.resetsAt),
      source: 'rate_limit_event',
      sidechain,
      sticky: false
    };
  }

  if (msg.type === 'assistant') {
    // Both conditions are required. A synthetic marker alone is not enough — the
    // SDK also tags a message `error: 'rate_limit'` when it is about to retry a
    // short-term 429, which is not an out-of-quota stop. And the notice alone is
    // not enough either, or the model quoting one would fabricate an error.
    if (!isSyntheticApiErrorMessage(msg)) return null;
    const text = collectText(msg.message);
    const notice = extractUsageLimitText(text);
    if (!notice) return null;
    return {
      text: notice,
      resetsAt: resetsAtFromText(text),
      source: 'assistant',
      sidechain,
      sticky: true
    };
  }

  if (msg.type === 'user') {
    // A Task tool_result relaying a subagent that died on the limit. The parent
    // may keep working afterwards, so this must not be cleared by later output:
    // the account is blocked regardless of who hit it first.
    const text = collectToolResultText(msg.message ?? msg);
    if (!text.includes(AGENT_ABORT_MARKER)) return null;
    const notice = extractUsageLimitText(text);
    if (!notice) return null;
    return {
      text: notice,
      resetsAt: resetsAtFromText(text),
      source: 'tool_result',
      sidechain,
      sticky: true
    };
  }

  if (msg.type === 'system' && msg.subtype === 'task_notification') {
    if (msg.status !== 'failed') return null;
    const notice = extractUsageLimitText(msg.summary);
    if (!notice) return null;
    return {
      text: notice,
      resetsAt: resetsAtFromText(msg.summary),
      source: 'task_notification',
      sidechain: true,
      sticky: true
    };
  }

  if (msg.type === 'result') {
    // `result` mirrors the turn's final assistant text, so require the notice at
    // the start: when the limit is what ended the turn the CLI sets the result to
    // the notice and nothing else. A turn that merely *mentions* one does not
    // begin with it.
    const text = typeof msg.result === 'string' ? msg.result.trim() : '';
    if (!USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
    const notice = extractUsageLimitText(text);
    if (!notice) return null;
    return {
      text: notice,
      resetsAt: resetsAtFromText(text),
      source: 'result',
      sidechain: false,
      sticky: true
    };
  }

  return null;
}

/**
 * Fold a detection into the turn's accumulated limit state.
 *
 * Sticky signals win and are never dropped. The newest one replaces the previous
 * only when it adds a reset time, so a precise `rate_limit_event` timestamp is
 * not overwritten by a later text-only notice.
 *
 * @param {object} turnState
 * @param {object} signal - a {@link detectUsageLimit} result
 */
export function recordUsageLimitSignal(turnState, signal) {
  if (!turnState || !signal) return;
  if (!signal.sticky) {
    turnState.softUsageLimitSignal = signal;
    return;
  }
  const previous = turnState.usageLimitSignal;
  if (!previous || (!previous.resetsAt && signal.resetsAt)) {
    turnState.usageLimitSignal = signal;
  }
}

/**
 * Clear a not-yet-terminal `rate_limit_event` once the turn demonstrably kept
 * working on the main line — the CLI's per-model fallback path. Sticky signals
 * are untouched.
 *
 * @param {object} turnState
 * @param {object} msg - the message that just arrived
 */
export function noteUsageLimitRecovery(turnState, msg) {
  if (!turnState || !turnState.softUsageLimitSignal) return;
  if (msg?.type !== 'assistant' || msg.parent_tool_use_id != null) return;
  const content = msg.message?.content;
  const producedOutput = typeof content === 'string'
    ? content.trim().length > 0
    : Array.isArray(content) && content.some((block) =>
        block?.type === 'tool_use'
        || (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0));
  if (producedOutput) {
    turnState.softUsageLimitSignal = null;
  }
}

/**
 * The turn's verdict: the signal that stopped it, or null when nothing did.
 *
 * A sticky signal wins, but borrows the reset timestamp from a `rate_limit_event`
 * seen in the same turn — that event is the only source that states the reset
 * time as an epoch, while the notice text states it as a wall-clock time.
 *
 * @param {object} turnState
 * @returns {object|null}
 */
export function resolveUsageLimitStop(turnState) {
  if (!turnState) return null;
  const sticky = turnState.usageLimitSignal;
  const soft = turnState.softUsageLimitSignal;
  if (!sticky) return soft || null;
  if (!sticky.resetsAt && soft?.resetsAt) return { ...sticky, resetsAt: soft.resetsAt };
  return sticky;
}

/**
 * Last-resort classification for a turn that threw: the notice may exist only in
 * the thrown error's message (a `result.is_error` whose text is the notice, or an
 * SDK rejection), with no in-stream message left to detect.
 *
 * @param {Error|unknown} error
 * @returns {object|null} a signal shaped like a {@link detectUsageLimit} result
 */
export function detectUsageLimitInThrownError(error) {
  const notice = extractUsageLimitText(error?.message || String(error ?? ''));
  return notice
    ? { text: notice, resetsAt: 0, source: 'result', sidechain: false, sticky: true }
    : null;
}

/**
 * Write the `[LIMIT_ERROR]` line — the single writer of this protocol tag, shared
 * by the daemon and per-process send paths so the two cannot drift.
 *
 * <p>It is a hint channel, not a result channel: it never completes or fails the
 * request. Java stores the payload and hands it to the auto-resume controller
 * alongside the turn error, so the wake can be scheduled from the reset time the
 * SDK reported even when the account-usage endpoint still lags enforcement and
 * claims nothing is exhausted.
 *
 * @param {object|null} signal - a {@link resolveUsageLimitStop} verdict; no-op when null
 * @param {boolean} raiseError - true when Java must synthesize the error itself
 *   (the turn ended in an ordinary success); false when a [SEND_ERROR] for the
 *   same stop is already on its way and would otherwise be reported twice.
 */
export function emitUsageLimitError(signal, raiseError) {
  if (!signal) return;
  console.log('[LIMIT_ERROR]', JSON.stringify({
    limitHit: true,
    message: truncateString(signal.text, 500),
    resetsAt: signal.resetsAt || 0,
    source: signal.source,
    sidechain: !!signal.sidechain,
    raiseError
  }));
}
