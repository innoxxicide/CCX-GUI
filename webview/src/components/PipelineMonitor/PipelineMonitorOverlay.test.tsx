import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse, SubagentInfo, SubagentStatus } from '../../types';
import PipelineMonitorOverlay from './PipelineMonitorOverlay';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: sendBridgeEventMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as TFunction;

function mk(id: string, type: string, status: SubagentStatus, extra?: Partial<SubagentInfo>): SubagentInfo {
  return {
    id,
    type,
    description: `${type} run`,
    prompt: `${type} instructions`,
    status,
    isAsync: true,
    messageIndex: 0,
    ...extra,
  };
}

function renderOverlay(subagents: SubagentInfo[], histories?: Record<string, SubagentHistoryResponse>) {
  return render(
    <PipelineMonitorOverlay
      subagents={subagents}
      t={t}
      onClose={() => {}}
      sessionId="session-1"
      histories={histories}
    />,
  );
}

describe('PipelineMonitorOverlay recovery', () => {
  it('asks for the transcript of every agent still claiming to run, and asks once', async () => {
    sendBridgeEventMock.mockClear();
    const { rerender } = renderOverlay([
      mk('tu-planner', 'planner', 'completed'),
      mk('tu-implementer', 'implementer', 'running'),
    ]);

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledTimes(1));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('load_subagent_session', JSON.stringify({
      sessionId: 'session-1',
      provider: 'claude',
      description: 'implementer run',
      toolUseId: 'tu-implementer',
    }));

    rerender(
      <PipelineMonitorOverlay
        subagents={[mk('tu-planner', 'planner', 'completed'), mk('tu-implementer', 'implementer', 'running')]}
        t={t}
        onClose={() => {}}
        sessionId="session-1"
      />,
    );
    expect(sendBridgeEventMock, 'a re-render is not a reason to ask again').toHaveBeenCalledTimes(1);
  });

  it('asks nothing before there is a session whose transcripts could be read', async () => {
    sendBridgeEventMock.mockClear();
    render(
      <PipelineMonitorOverlay
        subagents={[mk('tu-implementer', 'implementer', 'running')]}
        t={t}
        onClose={() => {}}
        sessionId={null}
      />,
    );

    await Promise.resolve();
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
  });

  it('polls the transcript of a live agent, so the phase on its node keeps up with it', async () => {
    vi.useFakeTimers();
    try {
      sendBridgeEventMock.mockClear();
      renderOverlay([mk('tu-implementer', 'implementer', 'running')]);

      expect(sendBridgeEventMock, 'the first read happens on open').toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens an interrupted step on what its transcript still holds', async () => {
    sendBridgeEventMock.mockClear();
    renderOverlay([
      mk('tu-planner', 'planner', 'completed'),
      mk('tu-implementer', 'implementer', 'running'),
      mk('tu-validator', 'validator', 'completed'),
    ]);

    const step = document.querySelector('[data-step-id="implementer"]');
    expect(step?.getAttribute('data-state'), 'the validator answered after it').toBe('stalled');

    fireEvent.click(step!);
    expect(screen.getByTestId('pipeline-stalled-note')).toBeTruthy();
    expect(screen.getByText('implementer instructions'), 'the prompt outlives the run that lost its result').toBeTruthy();
  });
});

describe('PipelineMonitorOverlay live reading', () => {
  const RUN = [
    mk('tu-planner', 'planner', 'completed', { resultText: 'Plan ready: 4 steps, no new files.' }),
    mk('tu-implementer', 'implementer', 'running'),
  ];

  function transcriptOf(text: string): SubagentHistoryResponse {
    return { success: true, messages: [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }] };
  }

  it('shows on the live node the phase its agent last wrote', () => {
    renderOverlay(RUN, { 'tu-implementer': transcriptOf('## Phase 2 — apply the fix\nEditing the selector now.') });

    const node = document.querySelector('[data-step-id="implementer"]');
    const activity = node?.querySelector('[data-testid="pipeline-step-activity"]');
    expect(activity?.getAttribute('data-kind')).toBe('phase');
    expect(activity?.textContent).toBe('Phase 2 — apply the fix');
  });

  it('shows on a settled node the opening line of what it handed on', () => {
    renderOverlay(RUN);

    const node = document.querySelector('[data-step-id="planner"]');
    const activity = node?.querySelector('[data-testid="pipeline-step-activity"]');
    expect(activity?.getAttribute('data-kind')).toBe('handoff');
    expect(activity?.textContent).toBe('Plan ready: 4 steps, no new files.');
  });

  it('draws the handoff as flowing while the step after works off it, and names what travelled', () => {
    renderOverlay(RUN);

    const link = document.querySelector('[data-testid="pipeline-track-link"][title^="Planner → Implementer"]');
    expect(link?.getAttribute('data-flow')).toBe('flowing');
    expect(link?.getAttribute('title')).toContain('Plan ready: 4 steps, no new files.');
  });

  it('draws a handoff that never happened as blocked, not as one still to come', () => {
    renderOverlay([
      mk('tu-planner', 'planner', 'completed'),
      mk('tu-implementer', 'implementer', 'running'),
      mk('tu-validator', 'validator', 'completed'),
    ]);

    const link = document.querySelector('[data-testid="pipeline-track-link"][title^="Implementer →"]');
    expect(link?.getAttribute('data-flow'), 'the implementer never reported back').toBe('blocked');
  });

  it('leaves the head of the track without an incoming link', () => {
    renderOverlay(RUN);

    const first = document.querySelectorAll('.pipeline-track-column')[0];
    expect(first.querySelector('[data-testid="pipeline-track-link"]')).toBeNull();
  });
});
