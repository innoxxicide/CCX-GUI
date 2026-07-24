import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStableSystemAppend,
  buildIDEContextMessage,
  buildIDEContextPrompt,
} from './system-prompts.js';

// Exact string UserMessageSanitizer.java matches to strip appended context from
// transcripts. buildIDEContextMessage must keep emitting it verbatim.
const SANITIZER_ANCHOR = '\n\n## User\'s Current IDE Context\n\nThe user is working in an IDE.';
const IDE_MARKER = '## User\'s Current IDE Context';

const sampleOpenedFiles = {
  active: 'src/App.tsx',
  selection: { startLine: 10, endLine: 12, selectedText: 'const x = 1;' },
  others: ['src/index.ts', 'src/util.ts'],
};

test('buildIDEContextMessage returns empty when there is no context', () => {
  assert.equal(buildIDEContextMessage(null), '');
  assert.equal(buildIDEContextMessage({}), '');
  assert.equal(buildIDEContextMessage({ others: [] }), '');
});

test('buildIDEContextMessage emits the sanitizer anchor and the actual data', () => {
  const msg = buildIDEContextMessage(sampleOpenedFiles);
  assert.ok(msg.includes(SANITIZER_ANCHOR), 'must keep the UserMessageSanitizer anchor byte-compatible');
  assert.ok(msg.includes('src/App.tsx'), 'includes active file');
  assert.ok(msg.includes('const x = 1;'), 'includes selected text');
  assert.ok(msg.includes('src/index.ts'), 'includes other open files');
});

test('buildIDEContextMessage keeps workspace/module sanitizer sub-anchors', () => {
  const workspaceMsg = buildIDEContextMessage({
    isWorkspace: true,
    workspaceRoot: '/repo',
    subprojects: [{ name: 'api', path: '/repo/api', type: 'gradle' }],
  });
  assert.ok(workspaceMsg.includes('### Multi-Project Workspace Structure'));

  const moduleMsg = buildIDEContextMessage({
    modules: [{ name: 'core' }, { name: 'ui' }],
  });
  assert.ok(moduleMsg.includes('### Project Module Structure\n\nThis project contains multiple modules:'));
});

test('buildStableSystemAppend never carries the volatile IDE marker', () => {
  // This is the core №0 invariant: the value fed into the runtime signature
  // (systemPrompt.append) must not change when the user navigates the IDE, so
  // the volatile IDE context must live in the user message, not here.
  assert.ok(!buildStableSystemAppend().includes(IDE_MARKER));
  assert.ok(!buildStableSystemAppend('You are a reviewer.').includes(IDE_MARKER));
});

test('buildStableSystemAppend is independent of opened files', () => {
  // It takes no openedFiles argument, so switching files cannot alter it — proven
  // by identical output across calls with the same agent prompt.
  assert.equal(buildStableSystemAppend('agent A'), buildStableSystemAppend('agent A'));
});

test('buildStableSystemAppend includes the agent role when provided', () => {
  const withAgent = buildStableSystemAppend('You are a reviewer.');
  assert.ok(withAgent.includes('## Agent Role and Instructions'));
  assert.ok(withAgent.includes('You are a reviewer.'));
  assert.ok(!buildStableSystemAppend().includes('## Agent Role and Instructions'));
});

test('buildIDEContextPrompt stays a composition of stable + IDE message', () => {
  const composed = buildIDEContextPrompt(sampleOpenedFiles, 'agent A');
  assert.equal(composed, buildStableSystemAppend('agent A') + buildIDEContextMessage(sampleOpenedFiles));
});
