# StatusPanel loses Tasks / Subagents after a stopped run is resumed

**Date**: 2026-08-01
**Version**: v0.0.4
**Status**: Fixed. Verified by unit tests; not yet exercised in a live `runIde` session.
**Area**: `webview/` — StatusPanel derivation (`useChatComputations` / `turnScope`)

---

## Symptom

In multi-agent runs, after the main agent stops (either on its own or via the Stop
button) and the user resumes it, work continues normally but the **Tasks** and
**Subagents** tabs above the prompt input go blank — no progress counter, and the
popovers report "no tasks" / "no subagents" — even while background subagents from
the interrupted turn are still executing.

The lists reappear once the resumed turn finishes, which is why the report said
this happens *often* rather than *always*: whenever the resumed agent happened to
write a new plan or launch a new subagent early, the gap was never noticed.

## Root cause

The StatusPanel does not read a session-level task/subagent store — both lists are
**derived from a message scope**, and while streaming that scope was narrowed to the
latest conversation turn (`useChatComputations.ts`, before this fix):

```ts
const statusScopeMessages = useMemo(() => {
  if (!streamingActive) return messages;
  return latestTurnMessages.length > 0 && sliceHasToolUse(latestTurnMessages, getContentBlocks)
    ? latestTurnMessages   // <- current turn only
    : messages;
}, [streamingActive, latestTurnMessages, messages, getContentBlocks]);
```

The narrowing itself is deliberate — it was introduced so a finished plan from an
earlier request would not keep accumulating in the panel. The defect is that it
treats a **turn boundary as a work-lifecycle boundary**, which it is not:

1. Resuming is just another user message, so it opens a new turn.
2. `sliceHasToolUse` flips to `true` the moment the resumed agent issues its first
   tool call — any tool, not just a task tool.
3. The scope collapses to that new turn, which contains no `TodoWrite` /
   `update_plan` block and no `Task` / `Agent` call — those live in the interrupted
   turn.
4. Both derivations therefore yield empty lists for the remainder of the turn.
5. When streaming settles the scope widens back to the whole transcript and the
   lists return.

Step 5 also means the pre-fix behaviour was internally inconsistent: idle showed
the carried-over plan, streaming hid it.

Background subagents make this worse than a cosmetic gap — they survive the
interrupt and keep running into the next turn, so the panel was reporting "no
subagents" about agents that were actively working.

## Changes

### `webview/src/utils/turnScope.ts`

- `findConversationTurnStarts(messages)` — indices of every turn-starting user
  message (`tool_result`-only user messages are transport noise, not boundaries).
- `resolveStatusScopeStart(subagents, turnStarts, latestTurnStart)` — pulls the
  scope start back to the **beginning of the earliest turn that still owns a
  running subagent**.

  The scope is pulled back to the *turn start*, not to the running agent's own
  message, on purpose: anchoring on the agent would drop its already-finished
  siblings and a group of "3 done + 2 running" would render as `0/2` instead of
  `3/5`.

### `webview/src/hooks/useChatComputations.ts`

- Subagents are now extracted from the **whole transcript** and the narrow scope is
  applied as a *filter* rather than a re-derivation. Two consequences: a running
  agent stays discoverable no matter which turn launched it, and `messageIndex`
  becomes a real transcript index — under the old code it was an index into the
  slice whenever the scope was narrowed.
- `deriveStatusPanelTodos()` (new, pure, exported for tests) — when the scoped turn
  has no plan of its own, the transcript's latest plan is carried over **as long as
  it still has unfinished items**. A fully completed plan is not carried, so the
  original "don't drag a finished plan into a new request" behaviour is preserved.

## Verification

- `webview`: `npm test` — 1014/1014 passing (118 files), `tsc -p tsconfig.test.json`
  and `tsc` (build config) both clean.
- New coverage: 8 cases in `webview/src/utils/turnScope.test.ts`
  (`findConversationTurnStarts`, `resolveStatusScopeStart`, including the
  finished-siblings and multi-turn walk-back cases) and 4 in
  `webview/src/hooks/useChatComputations.test.ts` (`deriveStatusPanelTodos`:
  carry-over, completed-plan suppression, current-turn plan wins, no-narrowing
  passthrough).
- Not verified live in `./gradlew runIde` — the tests prove the derivation, not the
  full Java → JCEF → panel chain.

## Key files

- `webview/src/utils/turnScope.ts`
- `webview/src/hooks/useChatComputations.ts`
- `webview/src/utils/turnScope.test.ts`
- `webview/src/hooks/useChatComputations.test.ts`

## Maintainer notes

- **A turn boundary is not a lifecycle boundary.** Anything derived from
  `sliceLatestConversationTurn` must ask whether the state it derives can outlive
  the turn that created it. Subagents and plans both can; file changes (which have
  their own `baseMessageIndex` mechanism) do not.
- **Don't re-derive subagents from a narrowed slice.** `SubagentInfo.messageIndex`
  is only meaningful against the full transcript; narrowing belongs after
  extraction, as a filter.
- **The `narrowStatusScope` widening exception is load-bearing.** It covers a
  deferred same-session reload landing just before the stream-end signal (see
  `06c32444`) and must not be folded into the new scope-start logic.
- **Known gap.** If every subagent of the interrupted turn had already finished by
  the time the run was stopped, the list is still hidden during the resumed turn.
  That case is indistinguishable from a normally completed previous request: the
  transcript carries no reliable interrupt marker, and `window.__deniedToolIds` is a
  mutable global outside React state, so it cannot back a `useMemo`. Closing this
  would need an explicit interrupt signal from the Java/bridge side.
