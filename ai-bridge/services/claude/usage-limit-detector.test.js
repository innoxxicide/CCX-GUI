import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUsageLimit,
  extractUsageLimitText,
  isUsageLimitText,
  noteUsageLimitRecovery,
  recordUsageLimitSignal,
  resolveUsageLimitStop,
} from './usage-limit-detector.js';

const NOTICE = "You've hit your session limit · resets 3pm (Europe/Kiev)";

/**
 * The synthetic assistant message Claude Code ends a quota-exhausted turn with,
 * copied from a real ~/.claude/projects transcript. Note `stop_reason` and the
 * ordinary-looking envelope: nothing here makes the SDK report a failed turn.
 */
function syntheticLimitMessage(overrides = {}) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    error: 'rate_limit',
    isApiErrorMessage: true,
    message: {
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: NOTICE }]
    },
    ...overrides
  };
}

function assistantText(text, overrides = {}) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...overrides
  };
}

// ===== text classification =====

test('isUsageLimitText matches the notice wherever it appears', () => {
  assert.equal(isUsageLimitText(NOTICE), true);
  assert.equal(isUsageLimitText(`Agent terminated early due to an API error: ${NOTICE}`), true);
  assert.equal(isUsageLimitText('Claude AI usage limit reached|1764512400'), true);
});

test('isUsageLimitText ignores warnings and overage transitions', () => {
  // The SDK classifies these separately: they never stop a turn.
  assert.equal(isUsageLimitText("You've used 80% of your session limit"), false);
  assert.equal(isUsageLimitText("You're close to your weekly limit"), false);
  assert.equal(isUsageLimitText("You're now using usage credits"), false);
  assert.equal(isUsageLimitText('This service is disabled for your org'), false);
  assert.equal(isUsageLimitText(''), false);
  assert.equal(isUsageLimitText(null), false);
});

test('extractUsageLimitText keeps only the notice line', () => {
  const relayed = `Agent terminated early due to an API error: ${NOTICE}\n\n`
    + 'Everything below is PARTIAL output recovered from the agent before it was cut off.';
  assert.equal(extractUsageLimitText(relayed), NOTICE);
});

// ===== message classification =====

test('detects the synthetic assistant message that ends a quota-exhausted turn', () => {
  const signal = detectUsageLimit(syntheticLimitMessage());
  assert.ok(signal);
  assert.equal(signal.text, NOTICE);
  assert.equal(signal.source, 'assistant');
  assert.equal(signal.sticky, true);
  assert.equal(signal.sidechain, false);
});

test('detects the same message when a subagent produced it', () => {
  const signal = detectUsageLimit(syntheticLimitMessage({ parent_tool_use_id: 'toolu_task_1' }));
  assert.ok(signal);
  assert.equal(signal.sidechain, true);
  assert.equal(signal.sticky, true);
});

test('an error-tagged assistant message without the notice is not a limit stop', () => {
  // The SDK also tags a message `rate_limit` when it is about to retry a 429.
  const signal = detectUsageLimit(assistantText('Working on it.', { error: 'rate_limit' }));
  assert.equal(signal, null);
});

test('the model quoting a limit notice is not a limit stop', () => {
  // Someone working on this very feature will have the agent read the notice
  // back to them. Without the synthetic marker that would fabricate an error and
  // swallow the answer.
  const signal = detectUsageLimit(assistantText(
    `The CLI ends the turn with "${NOTICE}" — that is the string to detect.`));
  assert.equal(signal, null);
});

test('a user pasting a limit notice is not a limit stop', () => {
  const signal = detectUsageLimit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: `Here is my log: Agent terminated early due to an API error: ${NOTICE}. Why?`
      }]
    }
  });
  assert.equal(signal, null);
});

test('a result that merely mentions the notice is not a limit stop', () => {
  assert.equal(detectUsageLimit({
    type: 'result',
    is_error: false,
    result: `I added detection for "${NOTICE}" to the bridge.`
  }), null);
});

test('a result that is the notice is a limit stop', () => {
  const signal = detectUsageLimit({ type: 'result', is_error: true, result: NOTICE });
  assert.ok(signal);
  assert.equal(signal.source, 'result');
});

test('a synthetic message is recognized by the <synthetic> model alone', () => {
  // Defence in depth: the marker set has changed across CLI versions.
  const signal = detectUsageLimit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: NOTICE }] }
  });
  assert.ok(signal);
  assert.equal(signal.source, 'assistant');
});

test('detects a Task tool_result relaying a subagent that ran out of quota', () => {
  const signal = detectUsageLimit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: `Agent terminated early due to an API error: ${NOTICE}\n\nPARTIAL output follows.` },
          { type: 'text', text: 'Now adding the tests.' }
        ]
      }]
    }
  });
  assert.ok(signal);
  assert.equal(signal.text, NOTICE);
  assert.equal(signal.source, 'tool_result');
  assert.equal(signal.sticky, true);
});

test('an ordinary tool_result is not a limit stop', () => {
  const signal = detectUsageLimit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok, 3 files changed' }] }
  });
  assert.equal(signal, null);
});

test('detects a failed background agent task_notification', () => {
  const signal = detectUsageLimit({
    type: 'system',
    subtype: 'task_notification',
    status: 'failed',
    task_id: 'a08794d30ae87ae7a',
    summary: `Agent "stage 3 tests" failed: Agent terminated early due to an API error: ${NOTICE}`
  });
  assert.ok(signal);
  assert.equal(signal.text, NOTICE);
  assert.equal(signal.source, 'task_notification');
  assert.equal(signal.sidechain, true);
});

test('a completed task_notification is not a limit stop', () => {
  const signal = detectUsageLimit({
    type: 'system',
    subtype: 'task_notification',
    status: 'completed',
    summary: 'Agent "stage 3 tests" finished'
  });
  assert.equal(signal, null);
});

test('a rejected rate_limit_event carries the reset epoch but is not sticky', () => {
  const signal = detectUsageLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1764512400, rateLimitType: 'five_hour' }
  });
  assert.ok(signal);
  assert.equal(signal.resetsAt, 1764512400000);
  assert.equal(signal.sticky, false);
});

test('an allowed rate_limit_event is ignored', () => {
  assert.equal(detectUsageLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', utilization: 82 }
  }), null);
});

test('detects the legacy pipe-epoch wording and its reset time', () => {
  const signal = detectUsageLimit(
    assistantText('Claude AI usage limit reached|1764512400', { isApiErrorMessage: true }));
  assert.ok(signal);
  assert.equal(signal.resetsAt, 1764512400000);
});

// ===== per-turn accumulation =====

test('a sticky signal survives later successful output', () => {
  // The parent agent often keeps working after a subagent dies on the limit —
  // the account is blocked all the same, so the turn is still a limit stop.
  const turnState = {};
  recordUsageLimitSignal(turnState, detectUsageLimit(syntheticLimitMessage({ parent_tool_use_id: 'toolu_1' })));
  noteUsageLimitRecovery(turnState, assistantText('The subagent failed, so I stopped here.'));

  const stop = resolveUsageLimitStop(turnState);
  assert.ok(stop);
  assert.equal(stop.source, 'assistant');
});

test('a bare rate_limit_event is cleared by later main-line output', () => {
  // The CLI emits one when it falls back from an exhausted per-model window to a
  // model that is still allowed; that turn completed and must not be flagged.
  const turnState = {};
  recordUsageLimitSignal(turnState, detectUsageLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1764512400 }
  }));
  noteUsageLimitRecovery(turnState, assistantText('Falling back and continuing.'));

  assert.equal(resolveUsageLimitStop(turnState), null);
});

test('subagent output does not clear a pending rate_limit_event', () => {
  const turnState = {};
  recordUsageLimitSignal(turnState, detectUsageLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1764512400 }
  }));
  noteUsageLimitRecovery(turnState, assistantText('sidechain chatter', { parent_tool_use_id: 'toolu_1' }));

  assert.ok(resolveUsageLimitStop(turnState));
});

test('the verdict borrows the reset epoch from a rate_limit_event in the same turn', () => {
  const turnState = {};
  recordUsageLimitSignal(turnState, detectUsageLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1764512400 }
  }));
  recordUsageLimitSignal(turnState, detectUsageLimit(syntheticLimitMessage()));

  const stop = resolveUsageLimitStop(turnState);
  assert.equal(stop.source, 'assistant');
  assert.equal(stop.text, NOTICE);
  assert.equal(stop.resetsAt, 1764512400000);
});

test('a turn with no limit signal has no verdict', () => {
  const turnState = {};
  noteUsageLimitRecovery(turnState, assistantText('All done.'));
  assert.equal(resolveUsageLimitStop(turnState), null);
});
