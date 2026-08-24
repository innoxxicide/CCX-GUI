# A usage-limit stop was not registered as an error, so auto-resume never armed

**Date:** 2026-08-24
**Symptom:** In multi-agent runs, hitting the account's usage limit put the limit
notice in the chat as ordinary agent text — no red error card — and the
"auto-resume after the limit resets" wake-up never fired.

---

## The behaviour this fix is built around

Claude Code **does not fail a turn when the account runs out of quota.** It ends
the turn with a *synthetic* assistant message and returns an ordinary success
result. Copied from a real `~/.claude/projects` transcript:

```json
{
  "type": "assistant",
  "isSidechain": false,
  "error": "rate_limit",
  "isApiErrorMessage": true,
  "message": {
    "model": "<synthetic>",
    "role": "assistant",
    "stop_reason": "stop_sequence",
    "usage": { "input_tokens": 0, "output_tokens": 0, "…": 0 },
    "content": [{ "type": "text", "text": "You've hit your session limit · resets 3pm (Europe/Kiev)" }]
  }
}
```

Note `stop_reason: "stop_sequence"` and the all-zero usage. From the query
loop's point of view the turn *completed*.

Verify this against the SDK typings rather than from memory — the shape has
moved before. `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts` exports
`USAGE_LIMIT_ERROR_PREFIXES` (the notices that mean a limit was genuinely
reached), and separately `USAGE_WARNING_PREFIXES` / `USAGE_TRANSITION_PREFIXES`
(which never stop a turn) and `ORG_POLICY_LIMIT_PREFIXES` (a different
condition). Those buckets are `@alpha`, which is why
`ai-bridge/services/claude/usage-limit-detector.js` mirrors the list rather than
importing it.

## Why the notice reached the chat but the error did not

Three independent gaps, all on the same stop:

1. **In-turn.** The synthetic message is text-only, so `shouldOutputMessage`
   suppresses its `[MESSAGE]` envelope in streaming mode — the `error` marker
   never reached Java. Its *text* still went out as `[CONTENT_DELTA]`, which is
   why the notice appeared, styled as agent output. No `[SEND_ERROR]` was
   emitted, so `ClaudeMessageHandler.onError` never ran: no error card, and no
   `notifyTurnError`, which is the only thing that arms auto-resume.

2. **Subagent-first.** In multi-agent runs the first thing to run out of quota is
   usually a subagent. The parent sees a Task `tool_result` reading
   `Agent terminated early due to an API error: <notice>` and often keeps
   working — summarising the failure and ending the turn cleanly. The bridge
   dropped that evidence anyway: `parent_tool_use_id`-bearing messages are
   filtered out of the main stream before anything looks at them.

3. **Inter-turn — the dominant case.** A background (`run_in_background`) agent
   wakes the session with a `task-notification`, and the CLI runs that
   continuation turn *outside* `executeTurn`. The perpetual reader only emits
   `session_updated` / `inter_turn_activity` for it. A limit stop there was
   completely silent: no error, no assessment, nothing.

On top of that, `ClaudeAutoResumeController` armed only if the **account-usage
endpoint** reported a window ≥95% used. That endpoint lags enforcement and is
unavailable entirely for API-key accounts, so even a detected stop could fail to
arm.

## What the fix does

`ai-bridge/services/claude/usage-limit-detector.js` is the single place that
recognizes a limit stop, on every shape it can arrive in: the synthetic
assistant message (main line **or** sidechain), a Task `tool_result`, a failed
`task_notification`, a rejected `rate_limit_event`, and a `result` whose text is
the notice. It runs **before** the `parent_tool_use_id` filter — the account is
blocked no matter which agent hit it first.

Signals are *sticky* except a bare `rate_limit_event`, which later successful
main-line output clears: the CLI emits one when it falls back from an exhausted
per-model window to a model that is still allowed, and that turn did not fail.

At the turn's end the bridge emits `[LIMIT_ERROR] {json}` (between `[STREAM_END]`
and `[MESSAGE_END]`), or a session-scoped `usage_limit` daemon event for the
inter-turn path. `raiseError` says who reports the error: `true` when the turn
ended in an ordinary success and Java must synthesize it, `false` when a
`[SEND_ERROR]` for the same stop is already in flight.

Java turns that into the normal error path — red card plus `notifyTurnError` —
and hands `ClaudeUsageLimitHint` to the auto-resume controller, which now arms on
the SDK's authority even when the endpoint disagrees, waking at the later of the
two reset times. The hint also survives a failed usage fetch.

### Two things that are easy to get wrong

- **The notice text is not sufficient evidence.** A user pasting a transcript, or
  the model discussing this very bug, would fabricate an error and swallow a real
  answer. Detection requires a structural marker as well: `error` /
  `isApiErrorMessage` / `model: "<synthetic>"` for assistant messages, a
  `tool_result` block (never the user's own text) for user messages, and the
  notice at the *start* of a `result`.

- **Reset time.** Only `rate_limit_event` states it as an epoch. Everything else
  states it as wall-clock text (`resets 3pm (Europe/Kiev)`), parsed by
  `ClaudeUsageLimitHint.parseResetsAtFromText` into the next occurrence of that
  time in that zone. Being slightly wrong is safe: the controller re-checks usage
  at the wake and reschedules if the block has not lifted.

## Also fixed in passing

The synthetic message's all-zero `usage` block used to be emitted as a `[USAGE]`
tag, which dropped the context-window gauge to 0 on every limit stop. Both send
paths now skip it along with the rest of that message.

## Related

- `docs/sdk/claude-agent-sdk.md` — `SDKAssistantMessageError`, `SDKRateLimitEvent`,
  `SDKTaskNotificationMessage`. The vendored copy predates
  `USAGE_LIMIT_ERROR_PREFIXES`; read the installed `sdk.d.ts` for that.
- `docs/feat/daemon-architecture-refactor.md` — the in-turn vs inter-turn split
  the third gap comes from.
