/**
 * On-disk diagnostic trace for the bridge daemon.
 *
 * Everything the daemon knows about its own failures — a runtime that refused
 * to start, a Remote Control bridge that was rejected, an SDK stream that died
 * inter-turn — is written to stdout/stderr, and Java keeps daemon stderr at
 * LOG.debug. At the default log level that leaves no trace anywhere on disk, so
 * a failure that happened an hour ago cannot be investigated at all. This tees
 * those lines into ~/.codemoss/logs/ai-bridge-<pid>.log.
 *
 * Conversation payload is deliberately excluded: the transcript is the user's
 * own text, the CLI already persists it, and a single turn of it would bury the
 * diagnostics this file exists for.
 */

import fs from 'fs';
import { join } from 'path';

import { getCodemossDir } from './path-utils.js';

// Markers that carry conversation content or per-message accounting rather than
// diagnostics. Matched at the start of a line, which is where every emitter in
// the bridge puts them.
const PAYLOAD_MARKERS = [
  '[MESSAGE]',
  '[MESSAGE_START]',
  '[MESSAGE_END]',
  '[CONTENT]',
  '[CONTENT_DELTA]',
  '[THINKING]',
  '[THINKING_DELTA]',
  '[TOOL_RESULT]',
  '[USAGE]',
  '[MCP_SERVER_TOOLS]',
  '[ENHANCED]',
];

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_LINE_CHARS = 2000;
const DEFAULT_KEEP_FILES = 5;
const LOG_FILE_PATTERN = /^ai-bridge-\d+\.log(\.1)?$/;

/**
 * Whether a line is conversation payload rather than a diagnostic.
 * @param {string} line
 * @returns {boolean}
 */
export function isPayloadLine(line) {
  const trimmed = line.trimStart();
  // Wrapped NDJSON envelopes are the same payload one layer down, and they are
  // already on their way to Java by definition.
  if (trimmed.startsWith('{')) return true;
  return PAYLOAD_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/**
 * Delete all but the newest `keep` bridge logs so a long-lived IDE install does
 * not accumulate one file per daemon process ever started.
 */
function pruneOldLogs(dir, keep, currentPath) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!LOG_FILE_PATTERN.test(name)) continue;
    const filePath = join(dir, name);
    if (filePath === currentPath) continue;
    try {
      entries.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
    } catch {
      // Vanished between readdir and stat — nothing to prune.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(Math.max(keep - 1, 0))) {
    try {
      fs.unlinkSync(entry.filePath);
    } catch {
      // A file another daemon holds open on Windows; it will be pruned later.
    }
  }
}

/**
 * Open a daemon log writer.
 *
 * Never throws: a log that cannot be written must not take the daemon down with
 * it, so the first failure disables the writer for the rest of the process.
 *
 * @param {object} [options]
 * @param {string} [options.dir] Directory to write into.
 * @param {number} [options.pid] Owning process id, used in the file name.
 * @param {() => number} [options.now] Clock, for deterministic tests.
 * @param {number} [options.maxBytes] Rotate once the file passes this size.
 * @param {number} [options.maxLineChars] Clip a single line to this length.
 * @param {number} [options.keepFiles] How many log files to leave on disk.
 * @returns {{filePath: string, write: (text: string) => void, isEnabled: () => boolean, close: () => void}}
 */
export function createDaemonLog(options = {}) {
  const dir = options.dir ?? join(getCodemossDir(), 'logs');
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const keepFiles = options.keepFiles ?? DEFAULT_KEEP_FILES;
  const filePath = join(dir, `ai-bridge-${pid}.log`);

  let enabled = true;
  let handle = null;
  let size = 0;

  const disable = () => {
    enabled = false;
    if (handle === null) return;
    try {
      fs.closeSync(handle);
    } catch {
      // Already gone.
    }
    handle = null;
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneOldLogs(dir, keepFiles, filePath);
    handle = fs.openSync(filePath, 'a');
    size = fs.fstatSync(handle).size;
  } catch {
    disable();
  }

  const rotate = () => {
    fs.closeSync(handle);
    handle = null;
    const backupPath = `${filePath}.1`;
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // No previous backup.
    }
    fs.renameSync(filePath, backupPath);
    handle = fs.openSync(filePath, 'a');
    size = 0;
  };

  return {
    filePath,
    isEnabled: () => enabled,
    write(text) {
      if (!enabled || typeof text !== 'string') return;
      const stamp = new Date(now()).toISOString();
      let chunk = '';
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trimEnd();
        if (line.length === 0 || isPayloadLine(line)) continue;
        const clipped = line.length > maxLineChars
          ? `${line.slice(0, maxLineChars)} …[clipped ${line.length - maxLineChars} chars]`
          : line;
        chunk += `${stamp} ${clipped}\n`;
      }
      if (chunk.length === 0) return;

      const bytes = Buffer.byteLength(chunk, 'utf8');
      try {
        if (size + bytes > maxBytes) rotate();
        fs.writeSync(handle, chunk, null, 'utf8');
        size += bytes;
      } catch {
        disable();
      }
    },
    close: disable,
  };
}

let sharedLog = null;

/**
 * Install the process-wide daemon log. Safe to call once at startup; later
 * calls replace the previous writer (tests rely on that).
 */
export function initDaemonLog(options = {}) {
  if (sharedLog) sharedLog.close();
  sharedLog = createDaemonLog(options);
  return sharedLog;
}

/**
 * Tee one chunk of daemon output into the log, if one was installed.
 */
export function writeDaemonLog(text) {
  if (!sharedLog) return;
  sharedLog.write(text);
}
