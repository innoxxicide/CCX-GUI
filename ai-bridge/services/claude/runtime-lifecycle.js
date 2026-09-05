import { AsyncStream } from '../../utils/async-stream.js';
import { loadClaudeSdk } from '../../utils/sdk-loader.js';
import { createPreToolUseHook, normalizePermissionMode } from './permission-mode.js';
import { parseTaskNotificationXml, buildTaskNotificationEvent, extractTaskNotificationXml } from './task-notification-parser.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes as cleanupAnonymousFromRegistry,
  cleanupStaleSessionRuntimes as cleanupSessionsFromRegistry,
  clearActiveTurnRuntimeIf,
  endRuntimeTurn,
  findRuntimeForRequest,
  rememberRuntime,
  promoteRuntimeToSession,
  removeRuntime,
  touchRuntime
} from './runtime-registry.js';
import { detectUsageLimit } from './usage-limit-detector.js';

let cachedQueryFn = null;

/**
 * Emit a process-level daemon event that bypasses daemon.js's activeRequestId
 * interception.
 *
 * _originalStdoutWrite is required because daemon.js intercepts process.stdout
 * .write and wraps output with the active request's id; a plain console.log
 * here would tag the event with whatever request is currently active (possibly
 * a different session) and misdeliver it. Writing directly to the original
 * stdout keeps the event process-level, which Java's DaemonBridge.handleDaemon
 * Event then routes to registered listeners.
 *
 * Hoisted to module scope (out of the perpetual reader closure) so executeTurn
 * can emit task events on the in-turn path too — see emitTaskEvent.
 */
function emitDaemonEvent(event, sessionId, payload = {}) {
  try {
    const originalWrite = process.stdout._originalStdoutWrite;
    if (!originalWrite) {
      console.error(`[PERPETUAL_READER] _originalStdoutWrite not available (daemon.js not initialized?), cannot emit ${event} event`);
      return;
    }
    const eventPayload = { type: 'daemon', event, sessionId, ...payload };
    originalWrite.call(process.stdout, JSON.stringify(eventPayload) + '\n', 'utf8');
  } catch (err) {
    console.error(`[PERPETUAL_READER] Failed to emit ${event} event:`, err);
  }
}

function emitInterTurnEvent(sessionId) {
  emitDaemonEvent('session_updated', sessionId);
}

/**
 * Forward a task lifecycle event to Java as a daemon event. The message is
 * either a real SDK task_* system event (settled after the turn's result, so
 * it arrives inter-turn) or a task_notification synthesized from a
 * <task-notification> XML carried by a main-session user message (recent
 * Claude Code delivers the background agent's terminal report that way
 * instead of emitting an SDK event). Both the perpetual reader (inter-turn)
 * and executeTurn (in-turn) call this so every delivery path converges on
 * window.onTaskEvent, which dedups by tool_use_id + observable fields.
 */
export function emitTaskEvent(sessionId, taskMsg) {
  emitDaemonEvent('task_event', sessionId, { taskEvent: taskMsg });
}

/**
 * TurnSink: A simple queue/channel for passing messages from the perpetual reader to executeTurn.
 * Used to coordinate message flow during active turns.
 *
 * The turnSink acts as a bridge between the perpetual reader (which owns runtime.query.next())
 * and executeTurn (which processes messages). This design ensures:
 * 1. Only one consumer (perpetual reader) calls query.next(), preventing buffering issues
 * 2. executeTurn receives messages via a simple queue without blocking the reader
 * 3. Clean separation between in-turn and inter-turn message routing
 */
export function createTurnSink() {
  const queue = [];
  const waiters = []; // FIFO queue of pending take() resolvers
  let failed = false;
  let failureError = null;

  return {
    /**
     * Push a message into the sink (called by perpetual reader during active turn).
     * Hands the message to the oldest pending take() if any, otherwise queues it.
     */
    push(msg) {
      if (failed) return; // Ignore pushes after failure
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },

    /**
     * Take the next message from the sink (called by executeTurn).
     * Returns a promise that resolves to { value, done }.
     * If no messages are queued, waits for the next push. Concurrent takers are
     * served in FIFO order so none are ever orphaned.
     */
    async take() {
      if (failed) {
        throw failureError;
      }
      if (queue.length > 0) {
        return { value: queue.shift(), done: false };
      }
      // Wait for next push
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    /**
     * Signal that the stream has failed or completed.
     * Idempotent: the first error wins, and every pending take() is rejected
     * once so none hang. After failure, take() throws synchronously, so no new
     * waiter can be enqueued.
     */
    fail(error) {
      if (failed) return; // Keep the first failure reason
      failed = true;
      failureError = error;
      while (waiters.length > 0) {
        waiters.shift().reject(error);
      }
    }
  };
}

export function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch, modelId) {
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled,
    runtimeSessionEpoch: runtimeSessionEpoch || '',
    model: options.model || '',
    effort: options.effort || '',
    // The [1m] suffix selects the 1M context window. The CLI subprocess locks
    // the window in at spawn from its environment, and setModel() cannot change
    // it afterwards (see shouldRecreateRuntimeForModel) — so toggling [1m] must
    // change the signature and rebuild the runtime instead of reusing it.
    contextWindow1M: (modelId || '').includes('[1m]'),
    // bypassPermissions (Auto mode) requires allowDangerouslySkipPermissions,
    // which the SDK passes as a process-launch argv flag — it is frozen at spawn
    // and setPermissionMode() (a runtime control request) cannot add it to a
    // live subprocess. So a runtime spawned in another mode keeps prompting via
    // canUseTool even after switching to Auto. Put the bypass state in the
    // signature so entering/leaving Auto rebuilds the runtime with the correct
    // launch flag. The other modes (default/plan/acceptEdits) need no launch
    // flag and keep applying live via setPermissionMode, so they intentionally
    // do NOT change the signature.
    bypassPermissions: options.permissionMode === 'bypassPermissions'
  };
  return JSON.stringify(material);
}

async function ensureQueryFn() {
  if (cachedQueryFn) return cachedQueryFn;
  const sdk = await loadClaudeSdk();
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  cachedQueryFn = queryFn;
  return cachedQueryFn;
}

export function setCachedQueryFn(queryFn) {
  cachedQueryFn = queryFn;
}

export function resetCachedQueryFn() {
  cachedQueryFn = null;
}

export function registerRuntimeSession(runtime, sessionId, callbacks) {
  promoteRuntimeToSession(runtime, sessionId, callbacks);
}

export async function disposeRuntime(runtime, callbacks) {
  if (!runtime || runtime.closed) return;
  console.log('[LIFECYCLE] disposeRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + (runtime.runtimeSignature || '(none)'));
  runtime.closed = true;
  runtime.activeTurnCount = 0;

  try {
    runtime.inputStream.done();
  } catch (err) {
    console.error('[LIFECYCLE] inputStream.done() failed:', err?.message || err);
  }

  try {
    runtime.query?.close?.();
  } catch (err) {
    console.error('[LIFECYCLE] query.close() failed:', err?.message || err);
  }

  removeRuntime(runtime, callbacks?.removeSession);
  clearActiveTurnRuntimeIf(runtime);
}

async function createRuntime(requestContext, callbacks) {
  const queryFn = await ensureQueryFn();
  const initialPermissionMode = normalizePermissionMode(requestContext.permissionMode);

  const runtime = {
    closed: false,
    sessionId: requestContext.requestedSessionId || null,
    runtimeSessionEpoch: requestContext.runtimeSessionEpoch || null,
    runtimeSignature: requestContext.runtimeSignature,
    currentModel: requestContext.sdkModelName || null,
    modelId: requestContext.modelId || null, // Original model ID, may contain [1m] suffix
    currentResolvedModel: requestContext.resolvedModelId || null,
    currentPermissionMode: initialPermissionMode,
    permissionModeState: { value: initialPermissionMode },
    currentMaxThinkingTokens: requestContext.maxThinkingTokens ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    activeTurnCount: 0,
    // CLI turn accounting for the quiescence gate — see waitForReaderQuiescent.
    // cliTurnInFlight: a run whose output we have seen but whose closing result
    // has not. readerProgress: ticks per message the perpetual reader routes.
    cliTurnInFlight: false,
    readerProgress: 0,
    stderrLines: [],
    query: null,
    inputStream: new AsyncStream(),
    titleGenerationAttempted: false
  };

  const options = {
    ...requestContext.options,
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (!text) return;
        runtime.stderrLines.push(text);
        if (runtime.stderrLines.length > 200) {
          runtime.stderrLines.shift();
        }
        console.error(`[SDK-STDERR] ${text}`);
      } catch (_) {
      }
    }
  };

  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [{
      hooks: [createPreToolUseHook(runtime.permissionModeState, options.cwd, async (mode) => {
        if (runtime.currentPermissionMode === mode) {
          runtime.permissionModeState.value = mode;
          return;
        }
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await runtime.query.setPermissionMode(mode);
          } catch (error) {
            console.warn('[LIFECYCLE] hook setPermissionMode failed, updating local state only:', error.message);
          }
        }
        // Always update local state to keep hook and runtime in sync
        runtime.currentPermissionMode = mode;
        runtime.permissionModeState.value = mode;
      })]
    }]
  };

  runtime.query = queryFn({
    prompt: runtime.inputStream,
    options
  });

  rememberRuntime(runtime, requestContext, callbacks?.registerActiveQueryResult);

  console.log('[LIFECYCLE] createRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + runtime.runtimeSignature);

  // Start the perpetual reader for this runtime
  // The reader will continuously consume runtime.query.next() for the runtime's lifetime
  startPerpetualReader(runtime, callbacks);

  return runtime;
}

/**
 * Wait until the perpetual reader has drained the SDK pipe and parked on
 * query.next() with no CLI run in flight. Called by executeTurn BEFORE it opens
 * the turn sink and enqueues the user message, so anything still buffered in the
 * pipe is prior-turn tail (e.g. a still-in-flight background run_in_background,
 * #1305) and routes inter-turn instead of into the new turn's sink — where its
 * output, and worse its closing result, would be misattributed and seed the
 * sticky "answered my previous message" / one-behind shift (#1410).
 *
 * Quiescence = a full macrotask with no reader progress (the reader is parked on
 * a pending query.next()) AND cliTurnInFlight === false. An idle pipe therefore
 * returns after one macrotask — the CLI would queue our send behind an in-flight
 * run anyway, so this adds no latency on the common path; it only aligns the
 * daemon's accounting with the CLI's actual order. Resolves on quiescence, on
 * dispose (runtime.closed is checked each tick so abort stays responsive and the
 * turn fails fast), or a loud 120s protocol-anomaly backstop so a stuck CLI
 * cannot wedge the daemon silently.
 */
export async function waitForReaderQuiescent(runtime) {
  if (!runtime || runtime.closed) {
    throw new Error('Runtime closed while waiting for the CLI to become quiet');
  }
  const deadline = Date.now() + 120_000;
  let lastProgress = runtime.readerProgress || 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (runtime.closed) {
      throw new Error('Runtime closed while waiting for the CLI to become quiet');
    }
    // Normalize: readerProgress is undefined until the reader processes its
    // first message, and undefined !== 0 would otherwise read as perpetual
    // progress and wedge the gate on a fresh/parked reader.
    const progress = runtime.readerProgress || 0;
    const progressed = progress !== lastProgress;
    lastProgress = progress;
    if (!progressed && !runtime.cliTurnInFlight) {
      return;
    }
    if (Date.now() > deadline) {
      console.warn('[LIFECYCLE] waitForReaderQuiescent timed out after 120s'
        + ' (protocol anomaly; proceeding) cliTurnInFlight=' + !!runtime.cliTurnInFlight);
      return;
    }
  }
}

/**
 * Start the perpetual reader for a runtime.
 * The reader continuously consumes runtime.query.next() for the runtime's lifetime,
 * routing messages to either the active turn (via turnSink) or inter-turn handling.
 *
 * This is the single source of truth for consuming the SDK query iterator.
 * executeTurn() no longer calls query.next() directly - it receives messages via turnSink.
 *
 * Exported for testing; returns the reader loop promise.
 */
export function startPerpetualReader(runtime, callbacks) {
  // emitDaemonEvent / emitInterTurnEvent / emitTaskEvent are defined at module
  // scope above so executeTurn can share the in-turn task-event emission path.
  // See those definitions for the bypass-activeRequestId rationale.

  // Signal that a background-task continuation is (in)active so the UI can show a
  // "working" indicator between the wake-up and its terminating result.
  const emitInterTurnActivity = (sessionId, active) =>
    emitDaemonEvent('inter_turn_activity', sessionId, { active });

  // A usage-limit stop that happens between turns. Background agents wake the
  // session with a task-notification, and the continuation turn the CLI runs for
  // it never passes through executeTurn — so [LIMIT_ERROR] cannot carry it and
  // the stop would otherwise be invisible: no error card, no auto-resume. The
  // event is session-scoped so only the owning chat window reacts.
  const emitUsageLimitEvent = (sessionId, signal) =>
    emitDaemonEvent('usage_limit', sessionId, {
      limit: {
        limitHit: true,
        message: signal.text,
        resetsAt: signal.resetsAt || 0,
        source: signal.source,
        sidechain: !!signal.sidechain,
        raiseError: true
      }
    });

  // An ordinary (non-usage-limit) failure of a between-turns continuation. Same
  // blind spot as emitUsageLimitEvent: a background agent's wake-up turn runs
  // outside executeTurn, so its error never reaches the [SEND_ERROR] path and
  // nothing would notice the agent had stopped. Routed to the chat window so
  // auto-retry-on-error can nudge it back to work.
  const emitTurnErrorEvent = (sessionId, message) =>
    emitDaemonEvent('turn_error', sessionId, { message });

  // Start the perpetual reader loop; return the promise so callers (and tests)
  // can await its completion.
  return (async () => {
    console.log('[PERPETUAL_READER] Starting for sessionId=' + (runtime.sessionId || '(new)'));

    try {
      while (!runtime.closed) {
        let next;

        try {
          next = await runtime.query.next();
        } catch (error) {
          console.error('[PERPETUAL_READER] query.next() error:', error?.message || error);
          // Forward error to turnSink if active turn exists
          if (runtime.turnSink) {
            runtime.turnSink.fail(error);
          }
          break; // Exit loop on error
        }

        // Check for iterator completion
        if (next.done) {
          console.log('[PERPETUAL_READER] Iterator completed (done: true)');
          if (runtime.turnSink) {
            runtime.turnSink.fail(new Error('stream ended'));
          }
          break; // Exit loop
        }

        const msg = next.value;

        // Keep the runtime's idle timer fresh while it actively produces output.
        // cleanupStaleSessionRuntimes reaps runtimes idle past SESSION_RUNTIME_MAX_IDLE_MS
        // and only spares those with activeTurnCount > 0 — which is 0 between turns.
        // Without this, a long-running background task (inter-turn) would be reaped
        // mid-flight, killing the SDK subprocess and losing its completion. In-turn
        // messages are also touched by executeTurn; touching here is idempotent and
        // additionally covers the inter-turn path executeTurn cannot see.
        touchRuntime(runtime);

        // CLI turn accounting for executeTurn's quiescence gate. Substantive
        // output (assistant / user / stream_event) means a CLI run is in flight;
        // its closing result clears it (output always precedes its result on the
        // pipe). system and other control messages leave the flag untouched, so
        // prewarmed/idle runtimes stay quiet. This lets a new user turn wait for
        // a still-in-flight run (e.g. a run_in_background completion, #1305)
        // instead of absorbing its output — and worse, its result — which is the
        // sticky "answered my previous message" / one-behind shift (#1410).
        if (msg?.type === 'result') {
          runtime.cliTurnInFlight = false;
        } else if (msg?.type === 'assistant' || msg?.type === 'user' || msg?.type === 'stream_event') {
          runtime.cliTurnInFlight = true;
        }
        // readerProgress ticks once per processed message so waitForReaderQuiescent
        // can tell a parked reader (no progress across a macrotask) from one still
        // draining the pipe.
        runtime.readerProgress = (runtime.readerProgress || 0) + 1;

        // Remote Control reports every transition as system/bridge_state, and that
        // message is the only place the CLI puts a reason for a bridge that was
        // refused or later dropped. Recorded before routing (either mode can carry
        // it) so setRemoteControlPersistent can answer with the cause instead of
        // the CLI's reasonless fallback string, and so the daemon log keeps a
        // timestamped trace of a bridge that died after it was switched on.
        if (msg?.type === 'system' && msg.subtype === 'bridge_state') {
          const detail = typeof msg.detail === 'string' ? msg.detail : '';
          runtime.lastBridgeState = { state: msg.state ?? null, detail, at: Date.now() };
          console.log('[PERPETUAL_READER] bridge_state=' + (msg.state ?? '(none)')
            + (detail ? ' detail=' + detail : '')
            + ' sessionId=' + (runtime.sessionId || '(new)'));
        }

        // Dual-mode routing: check if we're in an active turn or inter-turn period
        if (runtime.turnSink) {
          // IN-TURN MODE: Forward message to executeTurn via turnSink
          runtime.turnSink.push(msg);
        } else {
          // INTER-TURN MODE: a background-task completion (run_in_background Bash,
          // Monitor watch, or background subagent) injected a synthetic turn
          // (task-notification). There is no active request to tag this output with,
          // so we surface it to the chat window via sessionId-scoped daemon events:
          //   - inter_turn_activity(active:true) on the first message → UI shows the
          //     agent "woke up" and is working again,
          //   - session_updated per assistant message → the CLI has persisted new
          //     content to JSONL, so the window re-reads it and streams it in
          //     (reloads are coalesced Java-side, so bursts collapse cheaply),
          //   - session_updated + inter_turn_activity(active:false) on the terminating
          //     result → final refresh and clear the working indicator.
          // Anonymous runtimes are skipped: their content is not addressable to a
          // chat window (no registered sessionId yet).
          const sid = runtime.sessionId;
          const type = msg?.type;
          if (sid) {
            if (!runtime.interTurnActive && (type === 'assistant' || type === 'user' || type === 'result')) {
              runtime.interTurnActive = true;
              runtime.interTurnUsageLimitReported = false;
              emitInterTurnActivity(sid, true);
            }
            // Report the stop once per continuation: the CLI emits the synthetic
            // rate-limit assistant message and, right behind it, the terminating
            // result whose text repeats the notice.
            if (!runtime.interTurnUsageLimitReported) {
              const limitSignal = detectUsageLimit(msg);
              if (limitSignal) {
                runtime.interTurnUsageLimitReported = true;
                console.log('[PERPETUAL_READER] Inter-turn usage limit detected for sessionId=' + sid
                  + ', source=' + limitSignal.source);
                emitUsageLimitEvent(sid, limitSignal);
              }
            }
            if (type === 'assistant') {
              emitInterTurnEvent(sid);
            } else if (type === 'result') {
              console.log('[PERPETUAL_READER] Inter-turn result detected, emitting session_updated for sessionId=' + sid);
              emitInterTurnEvent(sid);
              // A continuation that ended badly for an ordinary reason. Reported
              // only when the usage-limit path did not already claim this
              // continuation, so a limit stop is never also treated as a retryable
              // failure — retrying one would hammer a blocked account.
              if (msg.is_error && !runtime.interTurnUsageLimitReported) {
                console.log('[PERPETUAL_READER] Inter-turn result is an error for sessionId=' + sid);
                emitTurnErrorEvent(sid, typeof msg.result === 'string' && msg.result
                  ? msg.result
                  : 'The agent stopped with an error between turns.');
              }
              if (runtime.interTurnActive) {
                runtime.interTurnActive = false;
                emitInterTurnActivity(sid, false);
              }
            }
            // 'user' (the synthetic task-notification) and other types only mark
            // activity; their content lands in the next assistant/result refresh.
          } else if (type === 'result') {
            // Anonymous runtime — no chat window to address; consume silently.
            console.log('[PERPETUAL_READER] Inter-turn result for anonymous runtime, consuming silently');
          }
          // task_* SDK system events (async subagent lifecycle) that reach
          // this inter-turn branch are the late ones - they settle AFTER the
          // turn's result, by which point executeTurn has already exited and
          // cleared turnSink, so they could not ride the in-turn [MESSAGE]
          // stream. A task_notification that settles BEFORE the result is
          // pushed to turnSink while it is still live, so executeTurn emits
          // it in-turn and it never reaches this branch. Forward the late
          // ones to Java so the frontend subagent list can mark the agent
          // done instead of staying stuck on "running" until a manual reload.
          // Other inter-turn message types are still silently consumed
          // (already persisted to JSONL by the CLI).
          if (msg?.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('task_')) {
            // Mirror emitInterTurnEvent's sessionId guard: anonymous runtimes
            // (no session_id yet) have no Java listener to claim the event, so
            // emitting {sessionId: null} only wastes a cross-process hop and
            // risks JsonNull handling on the Java side. Silently consume instead.
            if (runtime.sessionId) {
              console.log('[PERPETUAL_READER] Inter-turn task_* event for sessionId=' + runtime.sessionId + ', subtype=' + msg.subtype);
              emitTaskEvent(runtime.sessionId, msg);
            } else {
              console.log('[PERPETUAL_READER] Inter-turn task_* event for anonymous runtime, consuming silently (subtype=' + msg.subtype + ')');
            }
          }
          // Recent Claude Code terminates a background Agent by injecting a
          // <task-notification> XML into the main session, not as an SDK
          // task_notification event. The XML arrives as either a plain user
          // message (content) or a queued_command attachment (prompt); both are
          // recognized by extractTaskNotificationXml. It carries the agent's
          // full <result> report; inter-turn it is otherwise silently consumed
          // (the frontend only sees it after a reload). Parse the XML and
          // synthesize the task_notification event the SDK no longer emits, so
          // window.onTaskEvent can surface the report without waiting for a
          // reload. (The frontend also recovers these from history on its own —
          // see collectTaskEventsFromMessages — so this is the live fast-path.)
          const taskNotificationXml = extractTaskNotificationXml(msg);
          if (taskNotificationXml !== null) {
            // A <task-notification> XML carries a background agent's terminal
            // result report (recent CLI emits no separate `result` for it), so it
            // IS the run's completion — clear the in-flight flag so the next user
            // turn's quiescence gate does not wait on a run that already ended.
            runtime.cliTurnInFlight = false;
            if (runtime.sessionId) {
              const parsed = parseTaskNotificationXml(taskNotificationXml);
              const event = buildTaskNotificationEvent(parsed);
              if (event) {
                console.log('[PERPETUAL_READER] Inter-turn task-notification message for sessionId=' + runtime.sessionId + ', toolUseId=' + parsed.toolUseId + ', status=' + event.status);
                emitTaskEvent(runtime.sessionId, event);
              } else {
                console.log('[PERPETUAL_READER] Inter-turn task-notification message could not be parsed (no tool_use_id or non-terminal status), consuming silently');
              }
            } else {
              console.log('[PERPETUAL_READER] Inter-turn task-notification message for anonymous runtime, consuming silently');
            }
          }
          // For other message types during inter-turn, we silently consume
          // (they've already been persisted to JSONL by the CLI)
        }
      }
    } catch (error) {
      console.error('[PERPETUAL_READER] Unexpected error in reader loop:', error);
      if (runtime.turnSink) {
        runtime.turnSink.fail(error);
      }
    } finally {
      console.log('[PERPETUAL_READER] Exiting for sessionId=' + (runtime.sessionId || '(new)'));
      // If the reader dies mid-continuation (stream end / error before the
      // inter-turn result), clear the "working" indicator so the UI does not get
      // stuck showing the agent as active forever.
      if (runtime.interTurnActive && runtime.sessionId) {
        runtime.interTurnActive = false;
        emitInterTurnActivity(runtime.sessionId, false);
      }
      // The reader only exits on a terminal condition (query error, stream end,
      // or runtime closed) — never after a normal turn, where it blocks on the
      // next query.next() instead. If the runtime is still live here, the SDK
      // stream ended out-of-band (e.g. the subprocess died while idle between
      // turns). Evict it so the next request builds a fresh runtime rather than
      // reusing this one, whose dead reader would hang executeTurn's
      // turnSink.take() forever. disposeRuntime() is idempotent, so this is safe
      // even when the active-turn error path disposes the runtime too.
      if (!runtime.closed) {
        try {
          await disposeRuntime(runtime, callbacks);
        } catch (err) {
          console.error('[PERPETUAL_READER] dispose on exit failed:', err?.message || err);
        }
      }
    }
  })();
}

async function applyDynamicControls(runtime, requestContext) {
  if (!runtime || runtime.closed) return;

  const targetPermissionMode = normalizePermissionMode(requestContext.permissionMode);
  if (runtime.currentPermissionMode !== targetPermissionMode) {
    if (typeof runtime.query?.setPermissionMode === 'function') {
      try {
        await runtime.query.setPermissionMode(targetPermissionMode);
      } catch (error) {
        console.error('[DAEMON] setPermissionMode failed:', error.message);
      }
    }
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
  }

  const targetModel = requestContext.sdkModelName || null;
  const targetResolvedModel = requestContext.resolvedModelId || null;
  // Compare both the SDK short name AND the resolved model ID: a settings-side
  // remap (e.g. sonnet -> "MiniMax-M2.5") changes only the resolved ID.
  // Pass the resolved ID to setModel, not the short name: the CLI subprocess
  // resolves short names against its OWN environment, which was frozen at spawn
  // time — the daemon-side env update in setModelEnvironmentVariables never
  // reaches a live subprocess. The resolved ID needs no env lookup. ([1m]
  // toggles never get here: they change the runtime signature, so acquireRuntime
  // rebuilds the runtime instead of reusing it.)
  if ((runtime.currentModel !== targetModel || runtime.currentResolvedModel !== targetResolvedModel)
      && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetResolvedModel || targetModel || undefined);
      runtime.currentModel = targetModel;
      runtime.currentResolvedModel = targetResolvedModel;
    } catch (error) {
      console.error('[DAEMON] setModel failed:', error.message);
    }
  }

  const targetThinking = requestContext.maxThinkingTokens ?? null;
  if (runtime.currentMaxThinkingTokens !== targetThinking && typeof runtime.query?.setMaxThinkingTokens === 'function') {
    try {
      await runtime.query.setMaxThinkingTokens(targetThinking);
      runtime.currentMaxThinkingTokens = targetThinking;
    } catch (error) {
      console.error('[DAEMON] setMaxThinkingTokens failed:', error.message);
    }
  }
}

function assertRuntimeOwnership(runtime, requestContext) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    const err = new Error(
      `Runtime ownership mismatch: expected epoch ${requestContext.runtimeSessionEpoch}, got ${runtime.runtimeSessionEpoch || '(none)'}`
    );
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.requestedSessionId && runtime.sessionId && runtime.sessionId !== requestContext.requestedSessionId) {
    const err = new Error(
      `Runtime ownership mismatch: expected session ${requestContext.requestedSessionId}, got ${runtime.sessionId}`
    );
    err.runtimeTerminated = true;
    throw err;
  }
}

export async function acquireRuntime(requestContext, callbacks) {
  await cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));

  let runtime = findRuntimeForRequest(requestContext);

  // Never reuse a runtime that is closed but somehow still registered. If it
  // reached acquireRuntime, executeTurn would immediately throw "Runtime is
  // closed", and the prior abort left abortRequested=true on it, so sendInternal
  // would swallow that failure as a graceful "User interrupted" — silently
  // eating the message the user just sent. Evict it from the registry and treat
  // it as absent so a fresh runtime is created instead. (disposeRuntime removes
  // the runtime from the registry synchronously, so this branch is a defensive
  // invariant, not a common path.)
  if (runtime && runtime.closed) {
    console.log('[LIFECYCLE] discardClosedRuntime sessionId=' + (runtime.sessionId || '(new)')
      + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)'));
    removeRuntime(runtime, callbacks?.removeSession);
    runtime = null;
  }

  if (runtime && runtime.runtimeSignature !== requestContext.runtimeSignature) {
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (runtime && requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    console.log('[LIFECYCLE] disposeRuntimeForEpochMismatch existing=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' requested=' + requestContext.runtimeSessionEpoch);
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (!runtime) {
    runtime = await createRuntime(requestContext, callbacks);
  } else {
    console.log('[LIFECYCLE] reuseRuntime sessionId=' + (runtime.sessionId || '(new)')
      + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' signature=' + runtime.runtimeSignature);
  }

  assertRuntimeOwnership(runtime, requestContext);
  await applyDynamicControls(runtime, requestContext);
  touchRuntime(runtime);
  return runtime;
}

export async function cleanupStaleAnonymousRuntimes(callbacks) {
  return cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export async function cleanupStaleSessionRuntimes(callbacks) {
  return cleanupSessionsFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export { beginRuntimeTurn, endRuntimeTurn, touchRuntime, applyDynamicControls };
