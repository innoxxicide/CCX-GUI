import test from 'node:test';
import assert from 'node:assert/strict';

import { setRemoteControlPersistent, __testing } from './persistent-query-service.js';

/**
 * Tests for the Remote Control switch.
 *
 * The point of the feature is that the session already answering in the panel is
 * the one exposed on claude.ai, so these assert that the call lands on the LIVE
 * runtime and that a refusal reaches the caller instead of being swallowed into
 * a reported success.
 *
 * Nothing here touches buildRequestContext/setupApiKey, so it is CI-safe without
 * credentials.
 */

function createFakeRuntime(overrides = {}) {
  const calls = [];
  return {
    closed: false,
    sessionId: overrides.sessionId ?? 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    inputStream: { done() {} },
    query: {
      enableRemoteControl: overrides.enableRemoteControl
        ?? (async (enabled, name) => {
          calls.push({ enabled, name });
          return { bridge_session_id: 'bridge-1' };
        }),
    },
    __calls: calls,
    ...overrides.extra,
  };
}

function captureStdoutJson() {
  const lines = [];
  const original = console.log;
  console.log = (line) => { lines.push(line); };
  return {
    lines,
    restore() { console.log = original; },
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('exposes the live runtime and reports the SDK answer to the bridge', async () => {
  const runtime = createFakeRuntime();
  __testing.setActiveTurnRuntime(runtime);
  const stdout = captureStdoutJson();

  try {
    await setRemoteControlPersistent({ sessionId: 'sess-1', enabled: true, name: 'planner' });
  } finally {
    stdout.restore();
  }

  assert.deepEqual(runtime.__calls, [{ enabled: true, name: 'planner' }],
    'the control request must go to the runtime already backing this conversation');
  assert.equal(runtime.remoteControlEnabled, true);
  const payload = JSON.parse(stdout.lines.at(-1));
  assert.equal(payload.success, true);
  assert.equal(payload.enabled, true);
  assert.equal(payload.name, 'planner');
  assert.deepEqual(payload.response, { bridge_session_id: 'bridge-1' });
});

test('passes no name through when none was requested, leaving the SDK default', async () => {
  const runtime = createFakeRuntime();
  __testing.setActiveTurnRuntime(runtime);
  const stdout = captureStdoutJson();

  try {
    await setRemoteControlPersistent({ sessionId: 'sess-1', enabled: true, name: '   ' });
  } finally {
    stdout.restore();
  }

  assert.deepEqual(runtime.__calls, [{ enabled: true, name: undefined }],
    'a blank name must reach the SDK as absent, not as an empty display name');
});

test('surfaces the SDK refusal instead of reporting a handover that never happened', async () => {
  const runtime = createFakeRuntime({
    enableRemoteControl: async () => { throw new Error('Remote Control initialization failed'); },
  });
  __testing.setActiveTurnRuntime(runtime);
  const stdout = captureStdoutJson();

  try {
    await assert.rejects(
      () => setRemoteControlPersistent({ sessionId: 'sess-1', enabled: true }),
      /Remote Control initialization failed/,
    );
  } finally {
    stdout.restore();
  }

  assert.equal(stdout.lines.length, 0, 'a failed handover must not print a success payload');
});

test('rejects when the installed SDK has no Remote Control support', async () => {
  const runtime = createFakeRuntime();
  delete runtime.query.enableRemoteControl;
  __testing.setActiveTurnRuntime(runtime);

  await assert.rejects(
    () => setRemoteControlPersistent({ sessionId: 'sess-1', enabled: true }),
    /enableRemoteControl is not available/,
  );
});

test('detaching with no live runtime succeeds without spawning one', async () => {
  const stdout = captureStdoutJson();

  try {
    await setRemoteControlPersistent({ sessionId: 'sess-gone', enabled: false });
  } finally {
    stdout.restore();
  }

  const payload = JSON.parse(stdout.lines.at(-1));
  assert.equal(payload.success, true);
  assert.equal(payload.enabled, false);
});
