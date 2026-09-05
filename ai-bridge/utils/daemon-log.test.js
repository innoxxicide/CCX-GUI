import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createDaemonLog, initDaemonLog, isPayloadLine, writeDaemonLog } from './daemon-log.js';

/**
 * Tests for the daemon's on-disk diagnostic trace.
 *
 * The point of the file is that a failure survives long enough to be read after
 * the fact, without the log growing into a copy of the conversation or taking
 * the daemon down when the disk refuses it. Everything here runs in a temp dir.
 */

const createdDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  createdDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('a diagnostic line lands in the pid-named file with a timestamp', () => {
  const dir = tempDir();
  const log = createDaemonLog({ dir, pid: 4242, now: () => Date.parse('2026-09-05T17:30:08.779Z') });

  log.write('[LIFECYCLE] enableRemoteControl SDK error: no OAuth tokens\n');
  log.close();

  assert.equal(log.filePath, path.join(dir, 'ai-bridge-4242.log'));
  assert.equal(
    fs.readFileSync(log.filePath, 'utf8'),
    '2026-09-05T17:30:08.779Z [LIFECYCLE] enableRemoteControl SDK error: no OAuth tokens\n',
  );
});

test('conversation payload never reaches the file', () => {
  const dir = tempDir();
  const log = createDaemonLog({ dir, pid: 1 });

  log.write('[MESSAGE] {"type":"assistant","text":"secret plan"}\n');
  log.write('[CONTENT_DELTA] hello\n[USAGE] {"input_tokens":10}\n');
  log.write('{"id":"req-1","line":"[MESSAGE] wrapped"}\n');
  log.write('[DEBUG] runtime reused\n');
  log.close();

  const written = fs.readFileSync(log.filePath, 'utf8');
  assert.match(written, /\[DEBUG\] runtime reused/);
  assert.doesNotMatch(written, /secret plan|CONTENT_DELTA|USAGE|wrapped/);
});

test('payload detection covers markers and NDJSON envelopes, not diagnostics', () => {
  assert.equal(isPayloadLine('[MESSAGE] {}'), true);
  assert.equal(isPayloadLine('  [THINKING_DELTA] ...'), true);
  assert.equal(isPayloadLine('{"type":"daemon"}'), true);
  assert.equal(isPayloadLine('[PERPETUAL_READER] bridge_state=failed'), false);
});

test('an oversized line is clipped instead of filling the file', () => {
  const dir = tempDir();
  const log = createDaemonLog({ dir, pid: 2, maxLineChars: 20 });

  log.write(`[DEBUG] ${'x'.repeat(500)}\n`);
  log.close();

  const written = fs.readFileSync(log.filePath, 'utf8');
  assert.match(written, /\[DEBUG\] x{12} …\[clipped 488 chars\]/);
  assert.ok(written.length < 100, 'the clipped line must be short');
});

test('the file rotates into a single backup once it passes the size cap', () => {
  const dir = tempDir();
  const log = createDaemonLog({ dir, pid: 3, maxBytes: 200 });

  for (let i = 0; i < 10; i++) log.write(`[DEBUG] line ${i} ${'y'.repeat(40)}\n`);
  log.close();

  assert.ok(fs.existsSync(`${log.filePath}.1`), 'a backup must exist after rotation');
  assert.equal(fs.readdirSync(dir).length, 2, 'exactly one backup is kept');
  assert.match(fs.readFileSync(log.filePath, 'utf8'), /line 9/, 'the newest line is in the live file');
});

test('startup prunes to the newest logs and never deletes the live one', () => {
  const dir = tempDir();
  for (let i = 1; i <= 4; i++) {
    const stale = path.join(dir, `ai-bridge-${i}.log`);
    fs.writeFileSync(stale, 'old\n');
    fs.utimesSync(stale, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
  }
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me\n');

  const log = createDaemonLog({ dir, pid: 9, keepFiles: 3 });
  log.write('[DEBUG] fresh\n');
  log.close();

  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['ai-bridge-3.log', 'ai-bridge-4.log', 'ai-bridge-9.log', 'unrelated.txt']);
});

test('a directory that cannot be created disables the log instead of throwing', () => {
  const dir = tempDir();
  const blocked = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'file, not directory\n');

  const log = createDaemonLog({ dir: path.join(blocked, 'logs'), pid: 5 });
  log.write('[DEBUG] anything\n');

  assert.equal(log.isEnabled(), false);
  assert.equal(fs.existsSync(log.filePath), false);
});

test('writing after close is a no-op, and so is logging before init', () => {
  const dir = tempDir();
  const log = createDaemonLog({ dir, pid: 6 });
  log.write('[DEBUG] before close\n');
  log.close();
  log.write('[DEBUG] after close\n');

  assert.doesNotMatch(fs.readFileSync(log.filePath, 'utf8'), /after close/);
  writeDaemonLog('[DEBUG] no shared log installed\n');
});

test('the shared writer is what the daemon tees through', () => {
  const dir = tempDir();
  const log = initDaemonLog({ dir, pid: 7 });

  writeDaemonLog('[DAEMON] started\n');
  log.close();

  assert.match(fs.readFileSync(log.filePath, 'utf8'), /\[DAEMON\] started/);
});
