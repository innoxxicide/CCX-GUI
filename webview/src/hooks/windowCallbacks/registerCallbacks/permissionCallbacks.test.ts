import { registerPermissionCallbacks } from './permissionCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

/**
 * The Java side re-sends a dialog payload until the webview acknowledges it, because
 * CefBrowser.executeJavaScript silently drops snippets while the renderer is booting,
 * navigating, or restarting. Without the ack the retry loop keeps firing; without the
 * retry loop a dropped snippet means the dialog never appears while the agent stays
 * blocked on the permission response — forever when "auto-close on timeout" is off.
 */
describe('registerPermissionCallbacks - dialog_shown acknowledgement', () => {
  let sent: string[];

  const options = () => ({
    openPermissionDialog: vi.fn(),
    openAskUserQuestionDialog: vi.fn(),
    openPlanApprovalDialog: vi.fn(),
    forceClosePermissionDialog: vi.fn(),
    forceCloseAskUserQuestionDialog: vi.fn(),
    forceClosePlanApprovalDialog: vi.fn(),
  } as unknown as UseWindowCallbacksOptions);

  beforeEach(() => {
    sent = [];
    window.sendToJava = (payload: string) => { sent.push(payload); };
    delete window.showPermissionDialog;
    delete window.showAskUserQuestionDialog;
    delete window.showPlanApprovalDialog;
    delete window.__pendingPermissionDialogRequests;
    delete window.__pendingAskUserQuestionDialogRequests;
    delete window.__pendingPlanApprovalDialogRequests;
  });

  afterEach(() => {
    delete window.sendToJava;
  });

  it('acknowledges a permission dialog by channelId', () => {
    const opts = options();
    registerPermissionCallbacks(opts);

    window.showPermissionDialog?.(JSON.stringify({ channelId: 'ch-1', toolName: 'Bash', inputs: {} }));

    expect(opts.openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(sent).toContain('dialog_shown:ch-1');
  });

  it('acknowledges ask-user-question and plan-approval dialogs by requestId', () => {
    const opts = options();
    registerPermissionCallbacks(opts);

    window.showAskUserQuestionDialog?.(JSON.stringify({ requestId: 'ask-1', questions: [] }));
    window.showPlanApprovalDialog?.(JSON.stringify({ requestId: 'plan-1', plan: '' }));

    expect(sent).toContain('dialog_shown:ask-1');
    expect(sent).toContain('dialog_shown:plan-1');
  });

  it('acknowledges requests drained from the pre-mount placeholder queue', () => {
    // Java can push a dialog before React mounts; main.tsx parks it on
    // window.__pendingPermissionDialogRequests. The ack must be sent when that
    // queue is drained, otherwise Java keeps re-sending an already-shown dialog.
    window.__pendingPermissionDialogRequests = [
      JSON.stringify({ channelId: 'ch-early', toolName: 'Bash', inputs: {} }),
    ];

    const opts = options();
    registerPermissionCallbacks(opts);

    expect(opts.openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(sent).toContain('dialog_shown:ch-early');
  });

  it('does not acknowledge an unparseable payload', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const opts = options();
    registerPermissionCallbacks(opts);

    window.showPermissionDialog?.('not json');

    expect(opts.openPermissionDialog).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    consoleError.mockRestore();
  });

  it('does not acknowledge a payload with no request id', () => {
    // An ack for the wrong (or missing) id would silence the retry for a dialog that
    // was never actually delivered.
    const opts = options();
    registerPermissionCallbacks(opts);

    window.showPermissionDialog?.(JSON.stringify({ toolName: 'Bash', inputs: {} }));

    expect(sent).toEqual([]);
  });
});
