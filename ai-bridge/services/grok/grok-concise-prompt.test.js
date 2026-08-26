/**
 * Concise mode contract for Grok: the plugin contributes nothing of its own.
 *
 * Concise mode was introduced for the Claude path only, so every CLI provider kept
 * injecting its own prompt sections regardless of the setting. buildPromptBlocks is
 * where Grok assembles them, so the gate has to hold here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptBlocks } from './grok-acp-client.js';

const TEXT = (blocks) => blocks.find((b) => b.type === 'text')?.text ?? '';

test('concise mode sends the user message verbatim', () => {
  const blocks = buildPromptBlocks({
    message: 'why is the build slow?',
    agentPrompt: 'You are a performance specialist.',
    openedFiles: { active: 'C:\\proj\\src\\Main.java' },
    attachments: [],
    conciseMode: true,
  });

  assert.equal(TEXT(blocks), 'why is the build slow?');
});

test('concise mode off keeps the agent role and IDE context', () => {
  const blocks = buildPromptBlocks({
    message: 'why is the build slow?',
    agentPrompt: 'You are a performance specialist.',
    openedFiles: { active: 'C:\\proj\\src\\Main.java' },
    attachments: [],
    conciseMode: false,
  });

  const text = TEXT(blocks);
  assert.ok(text.includes('## Agent Role and Instructions'));
  assert.ok(text.includes('## IDE Context (opened files)'));
  assert.ok(text.includes('Main.java'));
});

test('concise mode defaults to off so callers must opt in explicitly', () => {
  const blocks = buildPromptBlocks({
    message: 'hi',
    agentPrompt: 'Role text.',
    openedFiles: null,
    attachments: [],
  });

  assert.ok(TEXT(blocks).includes('## Agent Role and Instructions'));
});
