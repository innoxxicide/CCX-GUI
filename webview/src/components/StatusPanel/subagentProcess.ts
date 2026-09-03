import type { SubagentHistoryResponse } from '../../types';

export interface SubagentProcessModel {
  notes: string[];
  readFiles: string[];
  toolCalls: Array<{ id: string; name: string; detail?: string }>;
}

/** What an agent is doing right now, read off the tail of its own transcript. */
export interface AgentActivity {
  /** The heading it wrote last — the phase of its own process it has reached. */
  phase?: string;
  /** The tool it reached for last, which is all there is to show before it writes a heading. */
  tool?: string;
  /** Its closing message: the report the orchestrator carries to the next step. */
  report?: string;
}

export function formatSubagentDuration(
  totalDurationMs?: number,
  units?: { ms?: string; s?: string },
): string | null {
  if (typeof totalDurationMs !== 'number') return null;
  const msLabel = units?.ms ?? 'ms';
  const sLabel = units?.s ?? 's';
  if (totalDurationMs < 1000) return `${totalDurationMs}${msLabel}`;
  return `${(totalDurationMs / 1000).toFixed(1)}${sLabel}`;
}

function getRawContent(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const frontendRaw = record.raw && typeof record.raw === 'object'
    ? record.raw as Record<string, unknown>
    : undefined;
  const nestedMessage = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : undefined;
  const content = frontendRaw?.content ?? nestedMessage?.content ?? record.content;
  return Array.isArray(content) ? content : [];
}

function getToolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const filePath = record.file_path ?? record.path;
  if (typeof filePath === 'string') return filePath;
  const command = record.command ?? record.cmd;
  if (typeof command === 'string') return command;
  const pattern = record.pattern;
  if (typeof pattern === 'string') return pattern;
  return undefined;
}

function compactPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 4 ? `…/${parts.slice(-4).join('/')}` : path;
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

const MARKDOWN_HEADING = /^#{1,6}\s+(\S.*)$/;
const BOLD_ONLY_LINE = /^\*\*(\S.*?)\*\*:?$/;
// Anchored on a number so ordinary prose ("Step back and look at …") cannot pass for a phase.
const NUMBERED_PHASE = /^((?:phase|step|stage|pass|sweep|round)\s*\d[^\n]{0,70})$/i;
const LIST_MARKER = /^[-*+]\s+/;

function headingOf(line: string): string | undefined {
  const trimmed = line.trim().replace(LIST_MARKER, '');
  const match = MARKDOWN_HEADING.exec(trimmed) ?? BOLD_ONLY_LINE.exec(trimmed) ?? NUMBERED_PHASE.exec(trimmed);
  if (!match) return undefined;
  const cleaned = match[1].replace(/[*`_#]/g, '').replace(/\s+/g, ' ').replace(/:$/, '').trim();
  return cleaned || undefined;
}

function lastHeadingIn(text: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split('\n')) {
    found = headingOf(line) ?? found;
  }
  return found;
}

/**
 * The tail of a transcript, in one pass: where the agent says it is, what it last
 * reached for, and what it ended up reporting.
 *
 * A heading the agent wrote in its own output outranks one it only thought, which is
 * why the two are collected apart: reasoning routinely lays out headings for work it
 * then decides against, and showing those would name a phase the run never entered.
 */
export function deriveAgentActivity(history?: SubagentHistoryResponse): AgentActivity {
  if (!history?.success || !Array.isArray(history.messages)) return {};

  const activity: AgentActivity = {};
  let thoughtPhase: string | undefined;

  for (const message of history.messages) {
    const raw = message && typeof message === 'object' ? message as Record<string, any> : {};
    if (raw.type !== 'assistant') continue;
    for (const block of getRawContent(message)) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, any>;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        activity.phase = lastHeadingIn(item.text) ?? activity.phase;
        activity.report = item.text.trim();
        continue;
      }
      if (item.type === 'thinking' && typeof item.thinking === 'string') {
        thoughtPhase = lastHeadingIn(item.thinking) ?? thoughtPhase;
        continue;
      }
      if (item.type !== 'tool_use') continue;
      const name = typeof item.name === 'string' ? item.name : 'Tool';
      const detail = getToolDetail(item.input);
      activity.tool = detail ? `${name} · ${compactPath(detail)}` : name;
    }
  }

  return { ...activity, phase: activity.phase ?? thoughtPhase };
}

export function buildSubagentProcessModel(history?: SubagentHistoryResponse): SubagentProcessModel {
  const model: SubagentProcessModel = { notes: [], readFiles: [], toolCalls: [] };
  if (!history?.success || !Array.isArray(history.messages)) return model;

  history.messages.forEach((message, messageIndex) => {
    const raw = message && typeof message === 'object' ? message as Record<string, any> : {};
    getRawContent(message).forEach((block, blockIndex) => {
      if (!block || typeof block !== 'object') return;
      const item = block as Record<string, any>;
      if (item.type === 'thinking'
        && raw.type === 'assistant'
        && typeof item.thinking === 'string'
        && item.thinking.trim()) {
        // The "thought" section must show the agent's actual reasoning, not
        // its output. A sidechain transcript's assistant messages carry
        // thinking blocks throughout and a single final text block with the
        // terminal report — collecting text here would surface the report in
        // the thought section, duplicating the result section.
        model.notes.push(item.thinking.trim());
        return;
      }
      if (item.type !== 'tool_use') return;

      const name = typeof item.name === 'string' ? item.name : 'Tool';
      const detail = getToolDetail(item.input);
      if (name.toLowerCase() === 'read' && detail) {
        pushUnique(model.readFiles, compactPath(detail));
        return;
      }
      model.toolCalls.push({
        id: `${messageIndex}-${blockIndex}`,
        name,
        detail: detail ? compactPath(detail) : undefined,
      });
    });
  });

  return model;
}
