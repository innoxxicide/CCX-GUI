import { act, renderHook } from '@testing-library/react';
import { useMessageQueue } from './useMessageQueue.js';

describe('useMessageQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The queue drains on the loading true -> false edge, so tests have to rerender
   * with the new isLoading value and then run the 50ms settle timer.
   */
  function drain(rerender: (props: { isLoading: boolean }) => void) {
    rerender({ isLoading: false });
    act(() => { vi.advanceTimersByTime(60); });
  }

  it('queues messages while loading and executes the first one when loading ends', () => {
    const onExecute = vi.fn();
    const { result, rerender } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueue('first'); });
    act(() => { result.current.enqueue('second'); });

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.hasQueuedMessages).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();

    drain(rerender);

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue).toHaveLength(1);
  });

  it('carries attachments through the queue', () => {
    const onExecute = vi.fn();
    const attachments = [{ id: 'a1', fileName: 'shot.png', mediaType: 'image/png', data: 'zzz' }];
    const { result, rerender } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueue('look at this', attachments as never); });
    drain(rerender);

    expect(onExecute).toHaveBeenCalledWith('look at this', attachments);
  });

  // "Send now" on a provider that cannot be steered stops the turn and relies on
  // this ordering: the immediate message must run before anything already queued.
  it('enqueueFront runs before messages that were already queued', () => {
    const onExecute = vi.fn();
    const { result, rerender } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueue('queued earlier'); });
    act(() => { result.current.enqueueFront('urgent correction'); });

    expect(result.current.queue.map(item => item.content)).toEqual([
      'urgent correction',
      'queued earlier',
    ]);

    drain(rerender);

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('urgent correction', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['queued earlier']);
  });

  it('enqueueFront keeps the relative order of repeated immediate sends', () => {
    const onExecute = vi.fn();
    const { result } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueueFront('first correction'); });
    act(() => { result.current.enqueueFront('second correction'); });

    expect(result.current.queue.map(item => item.content)).toEqual([
      'second correction',
      'first correction',
    ]);
  });

  it('dequeue removes a specific message without disturbing the rest', () => {
    const onExecute = vi.fn();
    const { result } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueue('one'); });
    act(() => { result.current.enqueue('two'); });
    act(() => { result.current.enqueue('three'); });

    const middleId = result.current.queue[1].id;
    act(() => { result.current.dequeue(middleId); });

    expect(result.current.queue.map(item => item.content)).toEqual(['one', 'three']);
  });

  it('clearQueue empties the queue', () => {
    const onExecute = vi.fn();
    const { result } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueue('one'); });
    act(() => { result.current.clearQueue(); });

    expect(result.current.queue).toHaveLength(0);
    expect(result.current.hasQueuedMessages).toBe(false);
  });

  it('does not execute anything when loading ends with an empty queue', () => {
    const onExecute = vi.fn();
    const { rerender } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    drain(rerender);

    expect(onExecute).not.toHaveBeenCalled();
  });

  it('drains one message per loading cycle', () => {
    const onExecute = vi.fn();
    const { result, rerender } = renderHook(
      ({ isLoading }) => useMessageQueue({ isLoading, onExecute }),
      { initialProps: { isLoading: true } }
    );

    act(() => { result.current.enqueue('first'); });
    act(() => { result.current.enqueue('second'); });

    drain(rerender);
    expect(onExecute).toHaveBeenCalledTimes(1);

    // Sending the drained message puts the session back into loading; the next
    // completion releases the following one.
    rerender({ isLoading: true });
    drain(rerender);

    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenLastCalledWith('second', undefined);
    expect(result.current.queue).toHaveLength(0);
  });
});
