import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
