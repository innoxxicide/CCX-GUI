import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type BridgeWindow = Window & typeof globalThis & {
  sendToJava?: (message: string) => void;
};

const CLAUDE_LIMITS_PAYLOAD = {
  available: true,
  fetchedAt: Date.now(),
  subscriptionType: 'max',
  usage: {
    five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    seven_day: { utilization: 61, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  },
};

interface AgentResultMeta {
  agentId: string;
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
}

function agentLaunch(toolUseId: string, subagentType: string, description: string, launchedAt?: string) {
  return {
    type: 'assistant',
    content: '',
    ...(launchedAt && { timestamp: launchedAt }),
    raw: {
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Task',
            input: { subagent_type: subagentType, description, prompt: `${description}\n\nFull instructions for ${subagentType}.` },
          },
        ],
      },
    },
  };
}

function agentReturn(toolUseId: string, resultText: string, meta: AgentResultMeta) {
  return {
    type: 'user',
    content: '',
    raw: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: resultText }] },
      ],
      toolUseResult: {
        status: 'completed',
        ...meta,
        toolStats: { readCount: 12, searchCount: 3, editCount: 4 },
      },
    },
  };
}

function agentFailure(toolUseId: string, resultText: string, meta: AgentResultMeta) {
  return {
    type: 'user',
    content: '',
    raw: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: [{ type: 'text', text: resultText }] },
      ],
      toolUseResult: { status: 'failed', ...meta },
    },
  };
}

/** Launch time of the agents these fixtures leave in flight, read against the real clock. */
const LIVE_AGENT_LAUNCHED_AT = new Date(Date.now() - 90_000).toISOString();

/** An ordinary chat that never launched an agent at all. */
const NO_PIPELINE_CHAT = [
  { type: 'user', content: 'What does the wall snapping threshold do?', timestamp: new Date().toISOString() },
  { type: 'assistant', content: 'It is the distance below which a dragged wall end snaps to a neighbour.' },
];

/**
 * A Standard run caught mid-flight, plus one agent outside the track so the
 * offTrack surface is exercised on screen rather than assumed.
 */
const MID_FLIGHT_STANDARD_RUN = [
  { type: 'user', content: 'Add the agent pipeline monitor to the chat header', timestamp: new Date().toISOString() },
  agentLaunch('tu-triage', 'triage', 'Route the task'),
  agentReturn('tu-triage', 'Routing: Standard. Score 21/50, no Full signal.', {
    agentId: 'agent-triage-1', totalDurationMs: 18_400, totalTokens: 24_180, totalToolUseCount: 6,
  }),
  agentLaunch('tu-planner', 'planner', 'Plan the implementation'),
  agentReturn('tu-planner', 'Plan ready: 4 phases, 9 RED specs, HAS_VISUAL yes.', {
    agentId: 'agent-planner-1', totalDurationMs: 62_629, totalTokens: 110_586, totalToolUseCount: 21,
  }),
  agentLaunch('tu-explore', 'general-purpose', 'Survey the webview component tree'),
  agentReturn('tu-explore', 'Header composition mapped, 3 insertion points found.', {
    agentId: 'agent-explore-1', totalDurationMs: 9_120, totalTokens: 12_940, totalToolUseCount: 8,
  }),
  agentLaunch('tu-explore-2', 'general-purpose', 'Survey the existing overlay styles'),
  agentReturn('tu-explore-2', 'Four dialogs share the backdrop pattern.', {
    agentId: 'agent-explore-2', totalDurationMs: 7_640, totalTokens: 10_310, totalToolUseCount: 5,
  }),
  agentLaunch('tu-implementer', 'implementer', 'Build the overlay', LIVE_AGENT_LAUNCHED_AT),
];

/**
 * The same Standard run carried into the review wave, where three roles run in
 * parallel and the track has to render them as one column rather than three steps.
 */
const REVIEW_WAVE_STANDARD_RUN = [
  { type: 'user', content: 'Add the agent pipeline monitor to the chat header', timestamp: new Date().toISOString() },
  agentLaunch('tu-planner', 'planner', 'Plan the implementation'),
  agentReturn('tu-planner', 'Plan ready: 4 phases, 9 RED specs.', {
    agentId: 'agent-planner-1', totalDurationMs: 62_629, totalTokens: 110_586, totalToolUseCount: 21,
  }),
  agentLaunch('tu-implementer', 'implementer', 'Build the overlay'),
  agentReturn('tu-implementer', 'Overlay built, 13 specs green.', {
    agentId: 'agent-implementer-1', totalDurationMs: 141_200, totalTokens: 268_310, totalToolUseCount: 48,
  }),
  agentLaunch('tu-cleanup', 'optimizer', 'Cleanup pass'),
  agentReturn('tu-cleanup', 'Two BATCH specs, one MUST-FIX.', {
    agentId: 'agent-optimizer-1', totalDurationMs: 33_900, totalTokens: 71_040, totalToolUseCount: 14,
  }),
  agentLaunch('tu-validator', 'validator', 'Verify the evidence'),
  agentReturn('tu-validator', 'Evidence fresh, all gates re-run.', {
    agentId: 'agent-validator-1', totalDurationMs: 47_500, totalTokens: 88_260, totalToolUseCount: 19,
  }),
  agentLaunch('tu-reviewer', 'reviewer', 'Guidelines review'),
  agentReturn('tu-reviewer', 'One HIGH, two MEDIUM findings.', {
    agentId: 'agent-reviewer-1', totalDurationMs: 51_010, totalTokens: 96_440, totalToolUseCount: 22,
  }),
  agentLaunch('tu-code-reviewer', 'code-reviewer', 'Baseline review'),
  agentReturn('tu-code-reviewer', 'No blocking defects.', {
    agentId: 'agent-code-reviewer-1', totalDurationMs: 44_770, totalTokens: 83_120, totalToolUseCount: 17,
  }),
  agentLaunch('tu-optimizer-phase2', 'optimizer', 'Phase 2 scoring'),
];

/**
 * The wave finishing out of order: the member listed last returns first while two
 * are still running, which must not let the audit after it claim the run got there.
 */
const OUT_OF_ORDER_WAVE_RUN = [
  { type: 'user', content: 'Add the agent pipeline monitor to the chat header', timestamp: new Date().toISOString() },
  agentLaunch('tu-planner', 'planner', 'Plan the implementation'),
  agentReturn('tu-planner', 'Plan ready: 4 phases, 9 RED specs.', {
    agentId: 'agent-planner-1', totalDurationMs: 62_629, totalTokens: 110_586, totalToolUseCount: 21,
  }),
  agentLaunch('tu-implementer', 'implementer', 'Build the overlay'),
  agentReturn('tu-implementer', 'Overlay built, 13 specs green.', {
    agentId: 'agent-implementer-1', totalDurationMs: 141_200, totalTokens: 268_310, totalToolUseCount: 48,
  }),
  agentLaunch('tu-cleanup', 'optimizer', 'Cleanup pass'),
  agentReturn('tu-cleanup', 'Two BATCH specs, one MUST-FIX.', {
    agentId: 'agent-optimizer-1', totalDurationMs: 33_900, totalTokens: 71_040, totalToolUseCount: 14,
  }),
  agentLaunch('tu-validator', 'validator', 'Verify the evidence'),
  agentReturn('tu-validator', 'Evidence fresh, all gates re-run.', {
    agentId: 'agent-validator-1', totalDurationMs: 47_500, totalTokens: 88_260, totalToolUseCount: 19,
  }),
  // Only one of the two live members carries a launch timestamp, so the wave shows
  // both what a counted step and an uncountable one look like side by side.
  agentLaunch('tu-reviewer', 'reviewer', 'Guidelines review', LIVE_AGENT_LAUNCHED_AT),
  agentLaunch('tu-code-reviewer', 'code-reviewer', 'Baseline review'),
  agentLaunch('tu-optimizer-phase2', 'optimizer', 'Phase 2 scoring'),
  agentReturn('tu-optimizer-phase2', 'Six specs scored, two above the bar.', {
    agentId: 'agent-optimizer-2', totalDurationMs: 28_400, totalTokens: 64_910, totalToolUseCount: 11,
  }),
];

/**
 * The review wave with two members in flight: one whose launch message carried a
 * timestamp and one that never got one, so both answers are asked for at once.
 */
function liveWaveRun(reviewerLaunchedAt: string) {
  return [
    { type: 'user', content: 'Add the agent pipeline monitor to the chat header' },
    agentLaunch('tu-planner', 'planner', 'Plan the implementation'),
    agentReturn('tu-planner', 'Plan ready: 4 phases, 9 RED specs.', {
      agentId: 'agent-planner-1', totalDurationMs: 62_629, totalTokens: 110_586, totalToolUseCount: 21,
    }),
    agentLaunch('tu-implementer', 'implementer', 'Build the overlay'),
    agentReturn('tu-implementer', 'Overlay built, 13 specs green.', {
      agentId: 'agent-implementer-1', totalDurationMs: 141_200, totalTokens: 268_310, totalToolUseCount: 48,
    }),
    agentLaunch('tu-validator', 'validator', 'Verify the evidence'),
    agentReturn('tu-validator', 'Evidence fresh, all gates re-run.', {
      agentId: 'agent-validator-1', totalDurationMs: 47_500, totalTokens: 88_260, totalToolUseCount: 19,
    }),
    agentLaunch('tu-reviewer', 'reviewer', 'Guidelines review', reviewerLaunchedAt),
    agentLaunch('tu-code-reviewer', 'code-reviewer', 'Baseline review'),
  ];
}

/**
 * A finished Standard run whose diff was mechanical, so the cleanup pass was skipped
 * and no optimizer ever launched — and whose implementer was relaunched for the
 * rework batch, leaving one slot holding two runs.
 */
const SKIPPED_CLEANUP_RUN = [
  { type: 'user', content: 'Roll the flag out to the remaining locales', timestamp: new Date().toISOString() },
  agentLaunch('tu-planner', 'planner', 'Plan the rollout'),
  agentReturn('tu-planner', 'Plan ready: mechanical diff, 3 files.', {
    agentId: 'agent-planner-1', totalDurationMs: 41_300, totalTokens: 88_100, totalToolUseCount: 15,
  }),
  agentLaunch('tu-implementer', 'implementer', 'Apply the plan'),
  agentReturn('tu-implementer', 'Rollout applied, all gates green.', {
    agentId: 'agent-implementer-1', totalDurationMs: 96_400, totalTokens: 174_220, totalToolUseCount: 31,
  }),
  agentLaunch('tu-validator', 'validator', 'Verify the evidence'),
  agentReturn('tu-validator', 'Evidence fresh; cleanup pass skipped as mechanical.', {
    agentId: 'agent-validator-1', totalDurationMs: 29_700, totalTokens: 54_880, totalToolUseCount: 13,
  }),
  agentLaunch('tu-reviewer', 'reviewer', 'Guidelines review'),
  agentReturn('tu-reviewer', 'Nothing above MEDIUM.', {
    agentId: 'agent-reviewer-1', totalDurationMs: 33_120, totalTokens: 62_400, totalToolUseCount: 16,
  }),
  agentLaunch('tu-code-reviewer', 'code-reviewer', 'Baseline review'),
  agentReturn('tu-code-reviewer', 'No blocking defects.', {
    agentId: 'agent-code-reviewer-1', totalDurationMs: 30_050, totalTokens: 58_910, totalToolUseCount: 14,
  }),
  agentLaunch('tu-implementer-rework', 'implementer', 'Apply the rework batch'),
  agentReturn('tu-implementer-rework', 'Two specs applied, one rejected.', {
    agentId: 'agent-implementer-2', totalDurationMs: 38_900, totalTokens: 61_450, totalToolUseCount: 12,
  }),
];

/** A Standard run whose validator came back failed, so one step on the track is in error. */
const FAILED_VALIDATOR_RUN = [
  { type: 'user', content: 'Fix the drag threshold regression', timestamp: new Date().toISOString() },
  agentLaunch('tu-planner', 'planner', 'Plan the fix'),
  agentReturn('tu-planner', 'Plan ready: 1 RED spec, 2 files.', {
    agentId: 'agent-planner-1', totalDurationMs: 39_400, totalTokens: 81_220, totalToolUseCount: 14,
  }),
  agentLaunch('tu-implementer', 'implementer', 'Apply the fix'),
  agentReturn('tu-implementer', 'Fix applied, gates green.', {
    agentId: 'agent-implementer-1', totalDurationMs: 88_100, totalTokens: 162_040, totalToolUseCount: 29,
  }),
  agentLaunch('tu-validator', 'validator', 'Verify the evidence'),
  agentFailure('tu-validator', 'Evidence is stale: DragTests ran before the last edit to WallDragHandler.cs.', {
    agentId: 'agent-validator-1', totalDurationMs: 21_800, totalTokens: 44_310, totalToolUseCount: 9,
  }),
];

async function installBridgeMocks(page: Page) {
  await page.addInitScript((appVersion) => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      claudePermissionMode: 'bypassPermissions',
    }));
    localStorage.setItem('lastSeenChangelogVersion', appVersion);

    const hideVConsole = () => {
      const style = document.createElement('style');
      style.textContent = '#__vconsole { display: none !important; pointer-events: none !important; }';
      (document.head || document.documentElement)?.appendChild(style);
    };
    if (document.head || document.documentElement) {
      hideVConsole();
    } else {
      window.addEventListener('DOMContentLoaded', hideVConsole, { once: true });
    }

    (window as BridgeWindow).sendToJava = () => {};
  }, APP_VERSION);
}

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

function significantErrors(errors: string[]) {
  return errors.filter((error) => !error.includes('ResizeObserver loop'));
}

async function seedPipelineRun(page: Page, run: unknown[] = MID_FLIGHT_STANDARD_RUN) {
  await page.goto('/');
  await expect(page.locator('.header-right')).toBeVisible();
  await page.evaluate(({ messages, limits }) => {
    window.onClaudeLimitsUpdate?.(JSON.stringify(limits));
    window.updateMessages?.(JSON.stringify(messages));
  }, { messages: run, limits: CLAUDE_LIMITS_PAYLOAD });
}

async function openOverlay(page: Page) {
  await page.getByTestId('pipeline-monitor-button').click();
  const overlay = page.getByTestId('pipeline-monitor-overlay');
  await expect(overlay).toBeVisible();
  return overlay;
}

test.beforeEach(async ({ page }) => {
  await installBridgeMocks(page);
});

test('pipeline monitor button sits left of the session-limits indicators', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page);

  const button = page.getByTestId('pipeline-monitor-button');
  const limits = page.locator('.claude-limits-indicators');
  await expect(button).toBeVisible();
  await expect(limits).toBeVisible();

  const buttonBox = await button.boundingBox();
  const limitsBox = await limits.boundingBox();
  expect(buttonBox, 'monitor button bounding box').not.toBeNull();
  expect(limitsBox, 'limits indicators bounding box').not.toBeNull();
  expect(buttonBox!.x + buttonBox!.width, 'monitor button right edge').toBeLessThanOrEqual(limitsBox!.x);

  const buttonPrecedesLimits = await page.evaluate(() => {
    const monitor = document.querySelector('[data-testid="pipeline-monitor-button"]');
    const indicators = document.querySelector('.claude-limits-indicators');
    if (!monitor || !indicators) return null;
    return Boolean(monitor.compareDocumentPosition(indicators) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(buttonPrecedesLimits, 'monitor button precedes limits in DOM order').toBe(true);

  expect(significantErrors(errors)).toEqual([]);
});

test('overlay draws the pale track with the live run highlighted on top', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page);
  const overlay = await openOverlay(page);

  await expect(overlay).toHaveAttribute('data-mode', 'standard');
  const activeBadge = page.getByTestId('pipeline-mode-badge').and(page.locator('[data-active="true"]'));
  await expect(activeBadge).toHaveCount(1);
  await expect(activeBadge).toHaveText('Standard');

  const steps = page.getByTestId('pipeline-step');
  const lastStep = page.locator('[data-testid="pipeline-step"][data-step-id="closer"]');
  await expect(lastStep, 'the tail of the track must not be clipped out of the panel').toBeInViewport();
  const panelBox = await overlay.boundingBox();
  for (const box of await steps.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) {
    expect(box, 'every step stays inside the panel').toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 2);
  }

  const pendingSteps = steps.and(page.locator('[data-state="pending"]'));
  const doneSteps = steps.and(page.locator('[data-state="done"]'));
  expect(await pendingSteps.count(), 'pale not-yet-reached steps').toBeGreaterThanOrEqual(3);
  expect(await doneSteps.count(), 'finished steps').toBeGreaterThanOrEqual(1);

  const runningStep = steps.and(page.locator('[data-state="running"]'));
  await expect(runningStep).toHaveCount(1);
  await expect(runningStep).toHaveAttribute('data-step-id', 'implementer');

  const summary = page.getByTestId('pipeline-monitor-summary');
  await expect(summary.locator('.pipeline-summary-running'), 'the summary names the live step').toHaveText('Implementer');
  await expect(summary.locator('.pipeline-summary-totals'), 'a summed wall-clock would misreport parallel agents')
    .toHaveText(/^\d+ tools · [\d,]+ tokens$/);

  const opacityOf = (locator: typeof runningStep) =>
    locator.first().evaluate((element) => Number(window.getComputedStyle(element).opacity));
  const runningOpacity = await opacityOf(runningStep);
  const pendingOpacity = await opacityOf(pendingSteps);
  expect(runningOpacity, 'live step must be visually stronger than the pale track').toBeGreaterThan(pendingOpacity);

  expect(significantErrors(errors)).toEqual([]);
});

test('the parallel review wave renders as one bracketed column, not three steps', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page, REVIEW_WAVE_STANDARD_RUN);
  await openOverlay(page);

  const waveIds = ['reviewer', 'code-reviewer', 'optimizer-phase2'];
  const parallelColumn = page.locator('.pipeline-track-column[data-parallel="true"]');
  await expect(parallelColumn, 'only the review wave fans out on the standard track').toHaveCount(1);
  expect(await parallelColumn.getByTestId('pipeline-step').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-step-id')),
  )).toEqual(waveIds);

  const sharedColumn = await page.evaluate((ids) => {
    const columns = ids.map((id) =>
      document.querySelector(`[data-testid="pipeline-step"][data-step-id="${id}"]`)?.closest('.pipeline-track-column'));
    return columns.every((column) => column !== null && column === columns[0]);
  }, waveIds);
  expect(sharedColumn, 'the three wave members must share one track column').toBe(true);

  const columnSizes = await page.locator('.pipeline-track-column').evaluateAll(
    (nodes) => nodes.map((node) => node.querySelectorAll('[data-testid="pipeline-step"]').length));
  expect(columnSizes.filter((size) => size > 1), 'no column beyond the wave stacks steps').toEqual([3]);
  expect(columnSizes.reduce((sum, size) => sum + size, 0)).toBe(await page.getByTestId('pipeline-step').count());

  const stateOf = (id: string) =>
    page.locator(`[data-testid="pipeline-step"][data-step-id="${id}"]`).getAttribute('data-state');
  expect(await stateOf('reviewer'), 'the wave must be reached, not pale').toBe('done');
  expect(await stateOf('optimizer-phase2')).toBe('running');
  expect(await stateOf('final-audit'), 'the audit follows the wave and has not been reached').toBe('pending');

  expect(significantErrors(errors)).toEqual([]);
});

test('a wave member finishing out of order does not mark the audit after it as reached', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page, OUT_OF_ORDER_WAVE_RUN);
  await openOverlay(page);

  const stateOf = (id: string) =>
    page.locator(`[data-testid="pipeline-step"][data-step-id="${id}"]`).getAttribute('data-state');
  expect(await stateOf('optimizer-phase2'), 'the member listed last finished first').toBe('done');
  expect(await stateOf('reviewer')).toBe('running');
  expect(await stateOf('code-reviewer')).toBe('running');
  expect(await stateOf('final-audit'), 'the wave is still running, so the audit must stay pale').toBe('pending');
  expect(await stateOf('closer')).toBe('pending');

  const finalAudit = page.locator('[data-testid="pipeline-step"][data-step-id="final-audit"]');
  const runningMember = page.locator('[data-testid="pipeline-step"][data-step-id="reviewer"]');
  const opacityOf = (locator: typeof finalAudit) =>
    locator.evaluate((element) => Number(window.getComputedStyle(element).opacity));
  expect(await opacityOf(finalAudit), 'the unreached audit must stay paler than the running wave member')
    .toBeLessThan(await opacityOf(runningMember));

  expect(significantErrors(errors)).toEqual([]);
});

test('a live step counts from its launch and a step with no launch time claims nothing', async ({ page }) => {
  const errors = collectPageErrors(page);
  // The page loads with the clock running from the launch instant, then freezes exactly
  // 90s later: the reading is an exact number instead of a pattern a count started when
  // the panel opened could also match.
  const launchedAt = Date.parse('2026-08-29T10:00:00.000Z');
  await page.clock.install({ time: launchedAt });
  await seedPipelineRun(page, liveWaveRun(new Date(launchedAt).toISOString()));
  await page.clock.pauseAt(launchedAt + 90_000);
  await openOverlay(page);

  const step = (id: string) => page.locator(`[data-testid="pipeline-step"][data-step-id="${id}"]`);
  await expect(step('reviewer')).toHaveAttribute('data-state', 'running');
  await expect(step('code-reviewer'), 'both members are equally live').toHaveAttribute('data-state', 'running');

  await expect(step('reviewer').locator('.pipeline-step-meta'), 'counted from the launch, not from the open')
    .toHaveText('90.0s');
  await expect(step('code-reviewer').locator('.pipeline-step-meta'), 'no launch time, so no number may be claimed')
    .toHaveCount(0);

  await page.clock.runFor(5_000);
  await expect(step('reviewer').locator('.pipeline-step-meta'), 'the count runs while the panel is open')
    .toHaveText('95.0s');
  await expect(step('validator').locator('.pipeline-step-meta'), 'a finished step keeps its recorded duration')
    .toHaveText('47.5s · 19 tools · 88,260 tokens');

  expect(significantErrors(errors)).toEqual([]);
});

test('a skipped cleanup pass leaves the audit reached and the run readable', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page, SKIPPED_CLEANUP_RUN);
  await openOverlay(page);

  const step = (id: string) => page.locator(`[data-testid="pipeline-step"][data-step-id="${id}"]`);
  expect(await step('optimizer-cleanup').getAttribute('data-state'), 'the diff was mechanical').toBe('pending');
  expect(await step('optimizer-phase2').getAttribute('data-state')).toBe('pending');
  await expect(step('optimizer-cleanup').locator('.pipeline-step-note')).toHaveText('conditional');
  expect(await step('final-audit').getAttribute('data-state'), 'no optimizer ran, and the audit still happened').toBe('done');

  const opacityOf = (id: string) =>
    step(id).evaluate((element) => Number(window.getComputedStyle(element).opacity));
  expect(await opacityOf('final-audit'), 'a reached audit must not render paler than a skipped step')
    .toBeGreaterThan(await opacityOf('optimizer-cleanup'));

  const implementer = step('implementer');
  await expect(implementer.locator('.pipeline-step-count'), 'the implementer ran twice').toHaveText('×2');
  await expect(implementer.locator('.pipeline-step-meta'), 'tool calls and tokens add up across runs, wall-clock does not')
    .toHaveText('43 tools · 235,670 tokens');

  const summary = page.getByTestId('pipeline-monitor-summary');
  await expect(summary, 'the skipped steps are not outstanding work').toContainText('7/7 steps done');
  await expect(summary.locator('.pipeline-summary-running'), 'the run is over').toHaveCount(0);

  await page.screenshot({ path: `/tmp/ccx-e2e/pipeline-monitor-skipped-cleanup-${testInfo.project.name}.png`, fullPage: true });
  expect(significantErrors(errors)).toEqual([]);
});

test('overlay reports what each finished agent returned and never drops an off-track agent', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page);
  await openOverlay(page);

  const plannerStep = page.locator('[data-testid="pipeline-step"][data-step-id="planner"]');
  await expect(plannerStep).toHaveAttribute('data-state', 'done');
  await expect(plannerStep.locator('.pipeline-step-meta')).toContainText('110,586');

  await plannerStep.click();
  const details = page.locator('.pipeline-monitor-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText('Plan ready');

  const offTrack = page.getByTestId('pipeline-offtrack-agent');
  await expect(offTrack, 'two runs of one type collapse into one chip').toHaveCount(1);
  await expect(offTrack).toContainText('general-purpose');
  await expect(offTrack.locator('.pipeline-step-count')).toHaveText('×2');

  await offTrack.click();
  await expect(details, 'an off-track agent is readable, not just countable').toContainText('Header composition mapped');
  await expect(details, 'the chip opens every run of that type').toContainText('Four dialogs share the backdrop pattern');
  await expect(details, 'opening the chip closes the step that was open').not.toContainText('Plan ready');

  expect(significantErrors(errors)).toEqual([]);
});

test('a failed step says what went wrong without being opened', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page, FAILED_VALIDATOR_RUN);
  await openOverlay(page);

  const validator = page.locator('[data-testid="pipeline-step"][data-step-id="validator"]');
  await expect(validator).toHaveAttribute('data-state', 'error');
  await expect(validator.getByTestId('pipeline-step-error')).toContainText('Evidence is stale');
  await expect(page.getByTestId('pipeline-step-error'), 'only the failed step carries a preview').toHaveCount(1);
  await expect(page.locator('.pipeline-monitor-details'), 'the preview is not an opened pane').toHaveCount(0);

  await page.screenshot({ path: `/tmp/ccx-e2e/pipeline-monitor-error-${testInfo.project.name}.png`, fullPage: true });
  expect(significantErrors(errors)).toEqual([]);
});

test('an ordinary chat with no agents claims no step was ever reached', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page, NO_PIPELINE_CHAT);
  const overlay = await openOverlay(page);

  await expect(overlay).toHaveAttribute('data-mode', 'undetermined');
  await expect(page.locator('.pipeline-monitor-hint')).toBeVisible();

  const steps = page.getByTestId('pipeline-step');
  expect(await steps.count(), 'the track is described even before it is walked').toBeGreaterThan(0);
  const states = await steps.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
  expect([...new Set(states)], 'nothing ran, so no step may claim any state').toEqual(['pending']);

  await expect(page.getByTestId('pipeline-monitor-summary')).toContainText('0/');
  await expect(page.locator('.pipeline-summary-totals'), 'no agent ran, so there is nothing to total').toHaveCount(0);
  await expect(page.getByTestId('pipeline-offtrack-agent')).toHaveCount(0);

  await page.screenshot({ path: `/tmp/ccx-e2e/pipeline-monitor-empty-${testInfo.project.name}.png`, fullPage: true });
  expect(significantErrors(errors)).toEqual([]);
});

test('overlay closes on Escape and on a backdrop click', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedPipelineRun(page);

  const overlay = page.getByTestId('pipeline-monitor-overlay');
  await openOverlay(page);
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);

  await openOverlay(page);
  await page.locator('.pipeline-monitor-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(overlay).toHaveCount(0);

  expect(significantErrors(errors)).toEqual([]);
});

test('capture the open overlay', async ({ page }, testInfo) => {
  await seedPipelineRun(page);
  await openOverlay(page);
  await page.screenshot({ path: `/tmp/ccx-e2e/pipeline-monitor-${testInfo.project.name}.png`, fullPage: true });

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: `/tmp/ccx-e2e/pipeline-monitor-light-${testInfo.project.name}.png`, fullPage: true });
});

test('capture the overlay with the review wave live', async ({ page }, testInfo) => {
  await seedPipelineRun(page, OUT_OF_ORDER_WAVE_RUN);
  await openOverlay(page);
  await page.screenshot({ path: `/tmp/ccx-e2e/pipeline-monitor-wave-${testInfo.project.name}.png`, fullPage: true });
});
