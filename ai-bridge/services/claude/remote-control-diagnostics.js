/**
 * Reconstructs why Remote Control was refused, because the CLI does not say.
 *
 * When the gate behind Remote Control reads as "off", the CLI returns before it
 * ever contacts the server and reports the reason only to its own debug log and
 * to telemetry: it never fires the state-change callback, so no bridge_state
 * message carries a detail and the control request rejects with a bare fallback
 * string ("Remote Control initialization failed"). That string is what the panel
 * shows, and it names nothing the user can act on.
 *
 * The most common cause is local and knowable here: feature-flag evaluation is
 * switched off by an env var, so the flag guarding Remote Control evaluates to
 * false regardless of what the account is entitled to. `claude doctor` names the
 * same variable — this reproduces that answer from the same inputs, since the
 * doctor text never reaches the SDK caller.
 *
 * Verified against Claude Code 2.1.260.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The CLI's own precedence when it decides which switch to blame, so the
// variable named here is the one `claude doctor` would name too.
const FLAG_BLOCKING_ENV_VARS = ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK'];

// DO_NOT_TRACK is a cross-vendor convention with one accepted spelling; the
// other two are read as plain env-var presence, where any non-empty value counts.
const STRICT_FLAG_VALUES = new Set(['1', 'true']);

// Fallback strings the CLI and the plugin use when neither knows the reason.
// Anything else already carries one and must reach the user untouched.
const GENERIC_FAILURES = new Set([
  'Remote Control initialization failed',
  'Remote Control request failed',
]);

// A bridge_state detail older than this belongs to an earlier attempt, and
// attaching it to this one would name the wrong cause.
const BRIDGE_STATE_MAX_AGE_MS = 30_000;

function managedSettingsPath() {
  if (process.platform === 'win32') {
    return join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json');
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  return '/etc/claude-code/managed-settings.json';
}

function readSettingsEnv(filePath) {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    const env = parsed?.env;
    return env && typeof env === 'object' ? env : null;
  } catch (_) {
    return null;
  }
}

/**
 * The env layers the CLI sees, ordered lowest to highest precedence: the process
 * environment first, then the settings files it is launched with
 * (--setting-sources=user,project,local), then the managed file, which outranks
 * every one of them.
 *
 * @returns {Array<{label: string, env: object|null}>}
 */
export function collectFlagEnvSources({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  readSettings = readSettingsEnv,
} = {}) {
  return [
    { label: 'the IDE environment', env },
    { label: '~/.claude/settings.json', env: readSettings(join(home, '.claude', 'settings.json')) },
    { label: '.claude/settings.json', env: readSettings(join(cwd, '.claude', 'settings.json')) },
    { label: '.claude/settings.local.json', env: readSettings(join(cwd, '.claude', 'settings.local.json')) },
    { label: 'managed settings', env: readSettings(managedSettingsPath()) },
  ];
}

function isBlockingValue(name, value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    return false;
  }
  if (name === 'DO_NOT_TRACK') {
    return STRICT_FLAG_VALUES.has(text.toLowerCase());
  }
  return true;
}

/**
 * The switch that turns feature-flag evaluation off, named together with the
 * layer that actually wins — a project file overriding a user file has to be
 * pointed at, or the user edits the wrong one.
 *
 * @param {Array<{label: string, env: object|null}>} sources - lowest precedence first.
 * @returns {{name: string, source: string}|null}
 */
export function findFlagBlockingVar(sources) {
  for (const name of FLAG_BLOCKING_ENV_VARS) {
    let winner = null;
    for (const source of sources || []) {
      const value = source?.env?.[name];
      if (value === undefined || value === null) {
        continue;
      }
      winner = { value, source: source.label };
    }
    if (winner && isBlockingValue(name, winner.value)) {
      return { name, source: winner.source };
    }
  }
  return null;
}

function recentBridgeDetail(bridgeState, now) {
  const detail = typeof bridgeState?.detail === 'string' ? bridgeState.detail.trim() : '';
  if (!detail) {
    return '';
  }
  if (typeof bridgeState.at === 'number' && now - bridgeState.at > BRIDGE_STATE_MAX_AGE_MS) {
    return '';
  }
  return detail;
}

/**
 * The message the user should see instead of the CLI's fallback string.
 *
 * @param {string} message - what the SDK rejected with.
 * @param {{bridgeState?: object|null, blocker?: {name: string, source: string}|null, now?: number}} context
 * @returns {string}
 */
export function describeRemoteControlFailure(message, { bridgeState = null, blocker = null, now = Date.now() } = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text && !GENERIC_FAILURES.has(text)) {
    return text;
  }

  const detail = recentBridgeDetail(bridgeState, now);
  if (detail) {
    return text ? `${text} — ${detail}` : detail;
  }

  if (blocker) {
    return `Remote Control needs feature-flag evaluation, which is off because ${blocker.name}`
      + ` is set in ${blocker.source}. Remove it there and restart the session.`;
  }

  return text || 'Remote Control request failed';
}

/**
 * describeRemoteControlFailure with the local env layers read from disk.
 *
 * @param {string} message - what the SDK rejected with.
 * @param {{bridgeState?: object|null, cwd?: string}} context
 * @returns {string}
 */
export function explainRemoteControlFailure(message, { bridgeState = null, cwd = process.cwd() } = {}) {
  const blocker = findFlagBlockingVar(collectFlagEnvSources({ cwd }));
  return describeRemoteControlFailure(message, { bridgeState, blocker });
}
