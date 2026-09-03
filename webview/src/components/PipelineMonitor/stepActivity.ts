import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import { deriveAgentActivity } from '../StatusPanel/subagentProcess';
import type { StepRun } from './derivePipelineRun';

export type HistoryMap = Record<string, SubagentHistoryResponse>;

/**
 * `phase` and `tool` say where a live step is; `handoff` says what a settled one
 * produced, which is also what the link out of it carries to the step after.
 */
export interface StepActivity {
  kind: 'phase' | 'tool' | 'handoff';
  /** Cut to one readable line, which is all a node has room for. */
  text: string;
  /** The same line uncut, for the hover title. */
  full: string;
}

const MAX_NODE_TEXT = 56;
const MAX_TITLE_TEXT = 220;
const FENCE_LINE = /^```/;

export function historyOf(agent: SubagentInfo, histories: HistoryMap): SubagentHistoryResponse | undefined {
  return histories[agent.id] ?? (agent.agentId ? histories[agent.agentId] : undefined);
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

// A report that opens with a fenced block has no sentence to quote, so the block is
// stepped over whole; one that is nothing but a fenced block says nothing here and
// stays where it can be read in full — the details pane below the track.
function openingLine(text?: string): string | undefined {
  if (!text) return undefined;
  let insideFence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (FENCE_LINE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence || !line) continue;
    return line;
  }
  return undefined;
}

function activityOf(entry: StepRun, histories: HistoryMap): StepActivity | undefined {
  // A slot holding several runs has no single place to be, and the fan's own nodes
  // each carry theirs; the orchestrator delegates nothing and has no transcript at all.
  if (entry.agents.length !== 1) return undefined;
  const agent = entry.agents[0];
  const live = deriveAgentActivity(historyOf(agent, histories));

  // A step that has not reported has no result to quote, so it shows where it stands
  // instead — the one that stalled included: the phase it died in is the whole story.
  if (entry.status === 'running' || entry.status === 'stalled') {
    const text = live.phase ?? live.tool;
    if (text) {
      return { kind: live.phase ? 'phase' : 'tool', text: clip(text, MAX_NODE_TEXT), full: clip(text, MAX_TITLE_TEXT) };
    }
  }

  // The tool result is the authoritative report; the transcript's closing message is
  // what is left when an interrupted session lost that result.
  const handoff = openingLine(agent.resultText) ?? openingLine(live.report);
  if (!handoff) return undefined;
  return { kind: 'handoff', text: clip(handoff, MAX_NODE_TEXT), full: clip(handoff, MAX_TITLE_TEXT) };
}

export function buildStepActivities(steps: StepRun[], histories: HistoryMap): Map<string, StepActivity> {
  const activities = new Map<string, StepActivity>();
  for (const entry of steps) {
    const activity = activityOf(entry, histories);
    if (activity) activities.set(entry.step.id, activity);
  }
  return activities;
}
