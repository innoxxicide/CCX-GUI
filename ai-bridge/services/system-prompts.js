/**
 * System prompt management module.
 *
 * This module builds various system prompts sent to the AI, including:
 * - IDE context information prompts (currently open files, selected code, etc.)
 * - Other system-level prompts
 *
 * Centralizes prompt management for easier maintenance and modification.
 */
import { getWindowsPathConstraint } from '../utils/prompt-utils.js';

const PROMPT_VALUE_MAX_LEN = 256;

/**
 * Reduce IDE-supplied strings (paths, names) to a single line and bounded
 * length before splicing into the system prompt. Defends against prompt
 * structure breakage from stray backticks, newlines or pathologically long
 * values without changing the prompt for normal inputs.
 *
 * Replaces ASCII control chars (0x00-0x1F, 0x7F) and backticks with spaces,
 * then collapses runs of whitespace.
 */
function sanitizePromptValue(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  str = str.replace(/[\x00-\x1F\x7F`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (str.length > PROMPT_VALUE_MAX_LEN) {
    str = str.slice(0, PROMPT_VALUE_MAX_LEN) + '...';
  }
  return str;
}

/**
 * Build the IDE context system prompt.
 *
 * This function constructs a detailed system prompt based on the user's working environment
 * in the IDE (open files, selected code, workspace structure, etc.), helping the AI understand
 * the user's current code context.
 *
 * @param {Object} openedFiles - Information about files open in the IDE
 * @param {string} openedFiles.active - Path of the currently active file (may include line markers #LX-Y)
 * @param {Object} openedFiles.selection - User's code selection information
 * @param {number} openedFiles.selection.startLine - Starting line number of the selection
 * @param {number} openedFiles.selection.endLine - Ending line number of the selection
 * @param {string} openedFiles.selection.selectedText - Content of the selected code
 * @param {string[]} openedFiles.others - List of other open file paths
 * @param {boolean} openedFiles.isWorkspace - Whether this is a multi-project workspace
 * @param {string} openedFiles.workspaceRoot - Root path of the workspace
 * @param {Array} openedFiles.subprojects - List of subprojects in the workspace
 * @param {Array} openedFiles.modules - List of modules in the project
 * @param {string} openedFiles.activeSubproject - Name of the subproject containing the active file
 * @param {string} agentPrompt - Agent prompt (optional)
 * @returns {string} The constructed system prompt, or an empty string if there's no valid information
 */
// Stable, per-conversation content for systemPrompt.append (agent role + the
// Windows path rule). It changes rarely, so it stays cacheable and does not churn
// the persistent runtime signature. Volatile IDE context (active file, selection,
// open files, workspace structure) is NOT included here — it goes into the user
// message via buildIDEContextMessage, so navigating the IDE between turns no longer
// invalidates the cached system-prompt prefix nor forces a runtime rebuild.
function buildStableSystemAppend(agentPrompt = null) {
  let prompt = '';

  if (agentPrompt && typeof agentPrompt === 'string' && agentPrompt.trim() !== '') {
    console.log('[Agent] [OK] buildStableSystemAppend: Adding agent prompt to system context');
    console.log('[Agent] [OK] Agent prompt preview:', agentPrompt.length > 100 ? agentPrompt.substring(0, 100) + '...' : agentPrompt);
    prompt += '\n\n## Agent Role and Instructions\n\n';
    prompt += 'You are acting as a specialized agent with the following role and instructions:\n\n';
    prompt += agentPrompt.trim();
    prompt += '\n\n**IMPORTANT**: Follow the above role and instructions throughout this conversation.\n';
    prompt += '\n---\n';
  }

  prompt += getWindowsPathConstraint({ extra: 'Apply this rule going forward, not just for this file.' });

  return prompt;
}

// Volatile IDE context appended to the user message (not the system prompt).
// Returns '' when there is nothing to add.
function buildIDEContextMessage(openedFiles) {
  if (!openedFiles || typeof openedFiles !== 'object') {
    return '';
  }

  // Only the active file and its selection are injected per turn. The open-files
  // list, workspace/subproject structure, and module list were deliberately
  // dropped: they are near-static per project (belong in CLAUDE.md, loaded via
  // settingSources) or low-signal, and were re-sent on every turn. The active
  // file path already reveals which subproject/module the user is in.
  const { active, selection } = openedFiles;
  const hasActive = active && active.trim() !== '';
  const hasSelection = selection && selection.selectedText;

  if (!hasActive) {
    return '';
  }

  console.log('[SystemPrompts] Building IDE context with active file:', active,
              'selection:', hasSelection ? 'yes' : 'no');

  // The header and the "The user is working in an IDE." sentence start are
  // load-bearing anchors: UserMessageSanitizer.java strips this appended context
  // from transcripts by matching these exact strings. Keep them byte-compatible.
  let prompt = '';
  prompt += '\n\n## User\'s Current IDE Context\n\n';
  prompt += 'The user is working in an IDE. When a request is vague ("this", "here", "fix this"), it refers to the selected code, or the active file when nothing is selected. Paths may carry `#LX-Y` / `#LX` line references.\n\n';
  prompt += `Active file: \`${sanitizePromptValue(active)}\`\n`;

  if (hasSelection) {
    prompt += `\nSelected lines ${selection.startLine}-${selection.endLine} (primary subject):\n`;
    prompt += '```\n';
    prompt += selection.selectedText;
    prompt += '\n```\n';
  }

  return prompt;
}

// Backward-compatible composition of the stable append and the IDE context.
// Prefer buildStableSystemAppend + buildIDEContextMessage directly so the two
// can be routed to different destinations (system prompt vs user message).
function buildIDEContextPrompt(openedFiles, agentPrompt = null) {
  return buildStableSystemAppend(agentPrompt) + buildIDEContextMessage(openedFiles);
}

/**
 * Export all prompt building functions.
 */
export {
  buildIDEContextPrompt,
  buildStableSystemAppend,
  buildIDEContextMessage,
  sanitizePromptValue,
};
