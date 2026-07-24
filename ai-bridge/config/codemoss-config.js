/**
 * Reader for the plugin's own settings file (~/.codemoss/config.json), written
 * by the Java CodemossSettingsService. Separate from ~/.claude/settings.json.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getCodemossDir } from '../utils/path-utils.js';

/**
 * Concise mode: when enabled, the plugin sends the agent nothing beyond the
 * user's own message — no systemPrompt.append (agent role, Windows path rule)
 * and no IDE-context suffix (active file, selection) — so the agent receives
 * exactly what it would in a plain terminal session.
 *
 * Defaults to false when the config is missing, malformed, or the field is unset,
 * matching the Java CodemossSettingsService default.
 * @returns {boolean}
 */
export function isConciseModeEnabled() {
  try {
    const configPath = join(getCodemossDir(), 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config?.conciseModeEnabled === true;
  } catch {
    return false;
  }
}
