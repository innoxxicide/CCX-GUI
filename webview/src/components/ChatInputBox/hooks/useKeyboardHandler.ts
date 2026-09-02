import { useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';

interface CompletionWithKeyDown {
  isOpen: boolean;
  handleKeyDown: (ev: KeyboardEvent) => boolean;
}

interface InlineCompletionHandler {
  applySuggestion: () => boolean;
}

export interface UseKeyboardHandlerOptions {
  isComposingRef: MutableRefObject<boolean>;
  lastCompositionEndTimeRef: MutableRefObject<number>;
  sendShortcut: 'enter' | 'cmdEnter';
  sdkStatusLoading: boolean;
  sdkInstalled: boolean;
  fileCompletion: CompletionWithKeyDown;
  commandCompletion: CompletionWithKeyDown;
  agentCompletion: CompletionWithKeyDown;
  promptCompletion: CompletionWithKeyDown;
  dollarCommandCompletion: CompletionWithKeyDown;
  handleMacCursorMovement: (e: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  handleHistoryKeyDown: (e: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => boolean;
  /** Inline history completion (Tab to apply) */
  inlineCompletion?: InlineCompletionHandler;
  completionSelectedRef: MutableRefObject<boolean>;
  submittedOnEnterRef: MutableRefObject<boolean>;
  handleSubmit: () => void;
  /** "Send now": stop the running turn and send, instead of queueing behind it. */
  handleSendNow?: () => void;
}

/**
 * The combo that jumps the queue. Shift alone is not available: Shift+Enter breaks
 * the line, which is exactly what a long mid-turn correction is typed with, so the
 * modifier rides on top of the send combo instead of replacing the newline.
 */
function isSendNowCombo(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, isEnterKey: boolean): boolean {
  return isEnterKey && e.shiftKey && (e.metaKey || e.ctrlKey);
}

/**
 * useKeyboardHandler - React keyboard event handling for the chat input box
 *
 * Handles:
 * - Completion dropdown navigation
 * - History navigation (when input empty)
 * - Send shortcut (Enter / Cmd+Enter)
 * - Preventing IME "confirm enter" false send
 */
export function useKeyboardHandler({
  isComposingRef,
  lastCompositionEndTimeRef,
  sendShortcut,
  sdkStatusLoading,
  sdkInstalled,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  promptCompletion,
  dollarCommandCompletion,
  handleMacCursorMovement,
  handleHistoryKeyDown,
  inlineCompletion,
  completionSelectedRef,
  submittedOnEnterRef,
  handleSubmit,
  handleSendNow,
}: UseKeyboardHandlerOptions) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const isIMEComposing = isComposingRef.current || e.nativeEvent.isComposing;

      const isEnterKey =
        e.key === 'Enter' || e.nativeEvent.keyCode === 13;

      if (handleMacCursorMovement(e)) return;

      const isCursorMovementKey =
        e.key === 'Home' ||
        e.key === 'End' ||
        ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.metaKey) ||
        ((e.key === 'e' || e.key === 'E') && e.ctrlKey && !e.metaKey);
      if (isCursorMovementKey) return;

      if (fileCompletion.isOpen) {
        const handled = fileCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (commandCompletion.isOpen) {
        const handled = commandCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (agentCompletion.isOpen) {
        const handled = agentCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (promptCompletion.isOpen) {
        const handled = promptCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (dollarCommandCompletion.isOpen) {
        const handled = dollarCommandCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      // Handle inline history completion (Tab key)
      if (e.key === 'Tab' && inlineCompletion) {
        const applied = inlineCompletion.applySuggestion();
        if (applied) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (handleHistoryKeyDown(e)) return;

      if (handleSendNow && isSendNowCombo(e, isEnterKey) && !isIMEComposing) {
        e.preventDefault();
        if (sdkStatusLoading || !sdkInstalled) return;
        submittedOnEnterRef.current = true;
        handleSendNow();
        return;
      }

      const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;
      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && (e.metaKey || e.ctrlKey) && !isIMEComposing
          : isEnterKey && !e.shiftKey && !isIMEComposing && !isRecentlyComposing;

      if (!isSendKey) return;

      e.preventDefault();
      if (sdkStatusLoading || !sdkInstalled) return;

      submittedOnEnterRef.current = true;
      handleSubmit();
    },
    [
      isComposingRef,
      handleMacCursorMovement,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      promptCompletion,
      dollarCommandCompletion,
      handleHistoryKeyDown,
      inlineCompletion,
      lastCompositionEndTimeRef,
      sendShortcut,
      sdkStatusLoading,
      sdkInstalled,
      submittedOnEnterRef,
      completionSelectedRef,
      handleSubmit,
      handleSendNow,
    ]
  );

  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const isEnterKey =
        e.key === 'Enter' || e.nativeEvent.keyCode === 13;

      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && (e.metaKey || e.ctrlKey)
          : isEnterKey && !e.shiftKey;

      if (!isSendKey && !isSendNowCombo(e, isEnterKey)) return;
      e.preventDefault();

      if (completionSelectedRef.current) {
        completionSelectedRef.current = false;
        return;
      }
      if (submittedOnEnterRef.current) {
        submittedOnEnterRef.current = false;
      }
    },
    [sendShortcut, completionSelectedRef, submittedOnEnterRef]
  );

  return { onKeyDown, onKeyUp };
}
