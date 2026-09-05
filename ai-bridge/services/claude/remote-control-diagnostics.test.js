import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFlagEnvSources,
  describeRemoteControlFailure,
  findFlagBlockingVar,
} from './remote-control-diagnostics.js';

/**
 * Tests for the Remote Control failure explanation.
 *
 * The point of the module is that a refusal the CLI cannot explain still reaches
 * the user as something actionable, and that a refusal the CLI DID explain is
 * never overwritten by a guess. Nothing here touches the SDK or the network.
 */

const GENERIC = 'Remote Control initialization failed';

function sources(overrides = {}) {
  return [
    { label: 'the IDE environment', env: overrides.process ?? {} },
    { label: '~/.claude/settings.json', env: overrides.user ?? null },
    { label: '.claude/settings.json', env: overrides.project ?? null },
    { label: '.claude/settings.local.json', env: overrides.local ?? null },
    { label: 'managed settings', env: overrides.managed ?? null },
  ];
}

test('names the settings file that disabled feature-flag evaluation', () => {
  const blocker = findFlagBlockingVar(sources({ user: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }));

  assert.deepEqual(blocker, {
    name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    source: '~/.claude/settings.json',
  });
});

test('the highest-precedence layer that sets the var is the one blamed', () => {
  const blocker = findFlagBlockingVar(sources({
    process: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    user: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    local: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  }));

  assert.equal(blocker.source, '.claude/settings.local.json');
});

test('a higher layer clearing the var wins over a lower one setting it', () => {
  const blocker = findFlagBlockingVar(sources({
    user: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    local: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' },
  }));

  assert.equal(blocker, null);
});

test('the CLI order decides which of several set switches is named', () => {
  const blocker = findFlagBlockingVar(sources({
    user: { DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  }));

  assert.equal(blocker.name, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
});

test('DO_NOT_TRACK only counts in its accepted spelling', () => {
  assert.equal(findFlagBlockingVar(sources({ user: { DO_NOT_TRACK: 'yes' } })), null);
  assert.equal(findFlagBlockingVar(sources({ user: { DO_NOT_TRACK: '1' } })).name, 'DO_NOT_TRACK');
});

test('nothing set means nothing is blamed', () => {
  assert.equal(findFlagBlockingVar(sources()), null);
});

test('the generic failure is replaced by the local cause', () => {
  const explained = describeRemoteControlFailure(GENERIC, {
    blocker: { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', source: '~/.claude/settings.json' },
  });

  assert.match(explained, /CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/);
  assert.match(explained, /~\/\.claude\/settings\.json/);
  assert.doesNotMatch(explained, /initialization failed/);
});

test('a reason the CLI did give is never overwritten', () => {
  const reported = 'Remote Control is disabled by your organization\'s policy';

  const explained = describeRemoteControlFailure(reported, {
    blocker: { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', source: '~/.claude/settings.json' },
  });

  assert.equal(explained, reported);
});

test('a fresh bridge_state detail outranks the local guess', () => {
  const now = 1_000_000;

  const explained = describeRemoteControlFailure(GENERIC, {
    bridgeState: { state: 'failed', detail: 'no OAuth tokens', at: now - 500 },
    blocker: { name: 'DISABLE_TELEMETRY', source: '~/.claude/settings.json' },
    now,
  });

  assert.equal(explained, `${GENERIC} — no OAuth tokens`);
});

test('a stale bridge_state belongs to an earlier attempt and is ignored', () => {
  const now = 1_000_000;

  const explained = describeRemoteControlFailure(GENERIC, {
    bridgeState: { state: 'failed', detail: 'no OAuth tokens', at: now - 120_000 },
    blocker: { name: 'DISABLE_TELEMETRY', source: '~/.claude/settings.json' },
    now,
  });

  assert.match(explained, /DISABLE_TELEMETRY/);
});

test('with no cause found the original text survives', () => {
  assert.equal(describeRemoteControlFailure(GENERIC, {}), GENERIC);
  assert.equal(describeRemoteControlFailure('', {}), 'Remote Control request failed');
});

test('the env layers are collected in the CLI precedence order', () => {
  const seen = [];
  const collected = collectFlagEnvSources({
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    home: '/home/dev',
    cwd: '/repo',
    readSettings: (filePath) => {
      seen.push(filePath);
      return null;
    },
  });

  assert.deepEqual(collected.map((source) => source.label), [
    'the IDE environment',
    '~/.claude/settings.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'managed settings',
  ]);
  assert.equal(collected[0].env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(seen.length, 4);
  assert.match(seen[0].replace(/\\/g, '/'), /^\/home\/dev\/\.claude\/settings\.json$/);
  assert.match(seen[1].replace(/\\/g, '/'), /^\/repo\/\.claude\/settings\.json$/);
  assert.match(seen[2].replace(/\\/g, '/'), /^\/repo\/\.claude\/settings\.local\.json$/);
});
