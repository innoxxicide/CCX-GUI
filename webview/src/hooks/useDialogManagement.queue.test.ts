import { act, renderHook } from '@testing-library/react';
import { useDialogManagement } from './useDialogManagement';

const t = ((key: string) => key) as any;

/**
 * A queued dialog request has no recovery path: Java blocks on the answer, and when the
 * user turns "auto-close dialog on timeout" off neither side has a safety net — so a
 * request that falls out of the queue hangs the agent forever with no dialog on screen.
 *
 * The queue used to be drained by an effect keyed on dialog *state*, while
 * openPermissionDialog decided what to enqueue from *refs* that a separate effect kept
 * mirroring back from state one commit behind. Both halves of that design are gone: the
 * refs are now the only source of truth, and every close path drains synchronously.
 */
describe('useDialogManagement - pending queue must never strand a request', () => {
  const mkPermission = (channelId: string) => ({ channelId, toolName: 'Bash', inputs: {} } as any);
  const mkAsk = (requestId: string) => ({ requestId } as any);

  it('opens the next queued permission request as soon as the active one is answered', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });
    expect(result.current.currentPermissionRequest?.channelId).toBe('A');

    act(() => { result.current.handlePermissionApprove('A'); });

    expect(result.current.permissionDialogOpen).toBe(true);
    expect(result.current.currentPermissionRequest?.channelId).toBe('B');
  });

  it('keeps every request when one arrives in the same tick as an approval', () => {
    // The lossy interleaving: the answer for A and the arrival of C land between a React
    // commit and its effect flush. Nothing may be dropped — B surfaces, C waits behind it.
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });

    act(() => {
      result.current.handlePermissionApprove('A');
      result.current.openPermissionDialog(mkPermission('C'));
    });
    expect(result.current.currentPermissionRequest?.channelId).toBe('B');

    act(() => { result.current.handlePermissionApprove('B'); });
    expect(result.current.currentPermissionRequest?.channelId).toBe('C');
  });

  it('drains a multi-entry queue in arrival order without losing an entry', () => {
    // Parallel tool calls in one assistant message produce several concurrent permission
    // requests, so a queue deeper than one is routine rather than exotic.
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openPermissionDialog(mkPermission('A'));
      result.current.openPermissionDialog(mkPermission('B'));
      result.current.openPermissionDialog(mkPermission('C'));
    });

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const active = result.current.currentPermissionRequest?.channelId;
      expect(active).toBeDefined();
      seen.push(active as string);
      act(() => { result.current.handlePermissionSkip(active as string); });
    }

    expect(seen).toEqual(['A', 'B', 'C']);
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('ignores a re-sent payload for the request that is already showing', () => {
    // Java re-sends unacknowledged dialogs; a repeat for the active request must be a no-op
    // rather than a duplicate queue entry that would re-prompt after the user answers.
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.handlePermissionApprove('A'); });

    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('ignores a re-sent payload for a request that is already queued', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });

    act(() => { result.current.handlePermissionApprove('A'); });
    expect(result.current.currentPermissionRequest?.channelId).toBe('B');

    act(() => { result.current.handlePermissionApprove('B'); });
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('opens the next queued question as soon as the active one is answered', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('Q1')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('Q2')); });

    act(() => { result.current.handleAskUserQuestionSubmit('Q1', {}); });

    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('Q2');
  });
});
