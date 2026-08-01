# The user's own prompt disappears when sent while subagents are running

**Date**: 2026-08-01
**Version**: v0.0.4
**Status**: Fixed. Verified by unit tests; not yet exercised in a live `runIde` session.
**Area**: `webview/` — optimistic message reconciliation (`windowCallbacks/messageSync`)

---

## Symptom

With background subagents running, a prompt sent to the main agent does not
appear in the transcript — or reappears much further up, above everything
generated since it was sent. The agent receives and answers it either way, so
only the user's own bubble is affected.

## Root cause

A submitted prompt is rendered optimistically: `useMessageSender.executeMessage`
appends a `{ isOptimistic: true }` user message before the backend has persisted
anything. Every `updateMessages` snapshot then replaces the whole list, and
`appendOptimisticMessageIfMissing` is the only thing that carries an
unconfirmed bubble across that replacement. It opened with:

```ts
const lastPrev = prevList[prevList.length - 1];
if (!lastPrev?.isOptimistic) return nextList;
```

so the bubble was protected **only while it was the last element of the list**.

That precondition breaks immediately. `onStreamStart`
(`streamingCallbacks.ts`) unconditionally appends an empty streaming assistant
placeholder as soon as the answering turn opens:

```ts
return [...prev, { type: 'assistant', content: '', isStreaming: true, ... }];
```

From that moment the optimistic message sits at `prev.length - 2`, the guard
bails, and the next backend snapshot generated *before* the prompt was persisted
replaces the list without it. The bubble is gone until a later snapshot carries
the backend's own copy — which lands at its transcript position, i.e. above all
the subagent cards and streamed content that arrived in the meantime. That is
the "reappears far above" half of the report.

Why multi-agent surfaces it: while background subagents run, the backend keeps
pushing snapshots (task events, transcript appends, `session_updated` reloads),
so a snapshot lagging behind the just-sent prompt is very likely to land inside
that window. In a quiet session the first snapshot after `onStreamStart`
usually already carries the persisted prompt, so the window is rarely hit.

The `matchedIndex < 0` comment block in the same function already names this
exact symptom ("my message disappears but the agent answers it") as previously
fixed — that round removed a *time* heuristic and left the *positional*
assumption in place.

## Changes

All in `webview/src/hooks/windowCallbacks/messageSync.ts`:

- `findOptimisticIndex()` — scans the tail of `prevList` for an unconfirmed
  optimistic message instead of checking only the last slot. Bounded by
  `OPTIMISTIC_MESSAGE_LOOKBACK` (4) so a bubble the backend never confirms
  cannot be resurrected forever once the conversation has moved past it.
- `resolveOptimisticInsertIndex()` — a restored bubble is inserted **before** the
  run of assistant messages that was appended after it in `prevList`, not at the
  end. Appending at the end would render the user's prompt below the answer it
  triggered. It counts only the assistants that followed the optimistic message,
  so a trailing assistant belonging to the *previous* turn still stays above the
  prompt.

When nothing follows the optimistic message the resolved index is exactly
`nextList.length`, so the classic path is a plain append as before — every
pre-existing test passed unmodified.

## Verification

- `webview`: `npm test` — 1018/1018 passing (118 files), `tsc -p
  tsconfig.test.json` and `tsc` (build config) both clean.
- New coverage in `webview/src/hooks/windowCallbacks/__tests__/messageSync.test.ts`:
  survives an `onStreamStart` placeholder (asserting position, not just
  presence); still appends at the end when nothing follows; no duplicate once
  the backend copy lands while the optimistic is no longer last; not resurrected
  beyond the lookback window.
- Not verified live in `./gradlew runIde`.

## Key files

- `webview/src/hooks/windowCallbacks/messageSync.ts`
- `webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts` (the
  `onStreamStart` append that breaks the precondition — unchanged)
- `webview/src/hooks/useMessageSender.ts` (where the optimistic message is created — unchanged)
- `webview/src/hooks/windowCallbacks/__tests__/messageSync.test.ts`

## Maintainer notes

- **"Last element" is not a durable identity for an in-flight message.** Three
  independent producers append to `messages` — the optimistic sender,
  `onStreamStart`, and the backend snapshot — so any reconciliation keyed on the
  tail slot is a race. `preserveLatestMessagesOnShrink` still slices by *length*
  (`prevList.slice(nextList.length)`); it survives because it filters duplicates
  by content afterwards, but it rests on the same kind of positional assumption.
- **Restoring a message is a placement decision, not just a presence decision.**
  Re-appending is only correct when nothing was appended after it locally.
- `OPTIMISTIC_MESSAGE_LOOKBACK` trades resurrection risk against protection
  window. 4 covers the realistic distance (placeholder, plus a message or two of
  slack); raising it would keep a never-confirmed bubble alive longer.
