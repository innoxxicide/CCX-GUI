import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type BridgeWindow = Window & typeof globalThis & {
  sendToJava?: (message: string) => void;
  __bridgeMessages?: string[];
};

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

    const bridgeWindow = window as BridgeWindow;
    bridgeWindow.__bridgeMessages = [];
    bridgeWindow.sendToJava = (message: string) => {
      bridgeWindow.__bridgeMessages?.push(message);
    };
  }, APP_VERSION);
}

async function bridgeMessages(page: Page) {
  return page.evaluate(() => (window as BridgeWindow).__bridgeMessages ?? []);
}

async function answerBackend(page: Page, payload: Record<string, unknown>) {
  await page.evaluate((json) => {
    window.onRemoteControlResult?.(json);
  }, JSON.stringify(payload));
}

test.beforeEach(async ({ page }) => {
  await installBridgeMocks(page);
  await page.goto('/');
  await expect(page.locator('.header-right')).toBeVisible();
});

test('the remote control button sits next to the pipeline monitor', async ({ page }) => {
  const remote = page.getByTestId('remote-control-button');
  const pipeline = page.getByTestId('pipeline-monitor-button');
  await expect(remote).toBeVisible();
  await expect(pipeline).toBeVisible();

  const pipelineBox = await pipeline.boundingBox();
  const remoteBox = await remote.boundingBox();
  expect(pipelineBox, 'pipeline button bounding box').not.toBeNull();
  expect(remoteBox, 'remote control button bounding box').not.toBeNull();
  expect(remoteBox!.x, 'the new button follows the pipeline one').toBeGreaterThanOrEqual(pipelineBox!.x);
  expect(remoteBox!.y, 'both sit on the same header row').toBeCloseTo(pipelineBox!.y, 0);
});

test('a click hands the session over and the button reports it back', async ({ page }) => {
  const button = page.getByTestId('remote-control-button');
  await expect(button).toHaveAttribute('data-state', 'off');

  await button.click();
  const sent = await bridgeMessages(page);
  const request = sent.find((message) => message.startsWith('set_remote_control:'));
  expect(request, 'the click must reach the backend').toBeTruthy();
  expect(JSON.parse(request!.substring('set_remote_control:'.length))).toEqual({ enabled: true });
  await expect(button).toHaveAttribute('data-state', 'pending');

  await answerBackend(page, { success: true, enabled: true });
  await expect(button).toHaveAttribute('data-state', 'on');

  await button.click();
  const afterSecondClick = await bridgeMessages(page);
  const offRequest = afterSecondClick.filter((message) => message.startsWith('set_remote_control:')).at(-1);
  expect(JSON.parse(offRequest!.substring('set_remote_control:'.length))).toEqual({ enabled: false });
});

test('a refused handover leaves the button off and shows the reason', async ({ page }) => {
  const button = page.getByTestId('remote-control-button');
  await button.click();
  await answerBackend(page, { success: false, error: 'Remote Control is not yet enabled for your account' });

  await expect(button).toHaveAttribute('data-state', 'off');
  await expect(button).toHaveAttribute('data-failed', 'true');
  await expect(button).toHaveAttribute('data-tooltip', 'Remote Control is not yet enabled for your account');
});
