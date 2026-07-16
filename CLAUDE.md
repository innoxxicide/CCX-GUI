# CLAUDE.md

Guidance for Claude Code when working in this repository. Its main job is **routing**: which document to read before touching which subsystem, and which skill to apply.

## What this project is

**CCX GUI (Claude or Codex)** — an IntelliJ IDEA plugin (currently v0.4.7) that gives Claude Code and OpenAI Codex a visual interface inside the IDE. It is a three-layer system, and almost every non-trivial change crosses at least two of the layers:

| Layer | Path | Stack |
|---|---|---|
| Plugin backend | `src/main/java/com/github/ccxgui/` | Java 17 target, Gradle, IntelliJ Platform |
| Webview UI | `webview/` | React 19 + TypeScript + Vite, rendered in JCEF |
| Agent bridge | `ai-bridge/` | Node 22, ESM, spawns/drives the Claude and Codex SDKs |

Java talks to the webview through `window.*` callbacks and `sendBridgeEvent`; Java talks to `ai-bridge` over an NDJSON stdin/stdout protocol. The bridge was formerly named `claude-bridge/` — that directory no longer exists, so any doc referencing it predates the rename.

## Commands

```bash
./gradlew test                # Java unit tests
./gradlew clean runIde        # launch a sandbox IDE with the plugin
./gradlew clean buildPlugin   # → build/distributions/ (~40MB)

cd webview && npm test        # vitest + tsc typecheck (both must pass)
cd webview && npm run build   # tsc && vite build
cd webview && npm run test:e2e  # playwright

node --test "ai-bridge/**/*.test.js"   # ai-bridge unit tests (what CI runs)
cd ai-bridge && npm run test:claude    # manual channel smoke tests
```

CI (`.github/workflows/tests.yml`) runs those three suites on JDK 21 / Node 22. `webview` and `ai-bridge` each need their own `npm ci`.

---

# Documentation map

## Vendored upstream reference — read for facts, never edit

These are verbatim copies of Anthropic's and OpenAI's docs, kept in-repo so contracts can be resolved offline. Refresh them by re-vendoring, not by hand.

| Read when you need | File |
|---|---|
| `query()` options, `SDKMessage` shapes, hook payloads, tool schemas | `docs/sdk/claude-agent-sdk.md` |
| Permission evaluation order, the four modes, `canUseTool`, the `AskUserQuestion` answer contract | `docs/sdk/claude-sdk-permissions.md` |
| `settings.json` keys, scope precedence, env-var table | `docs/sdk/claude-settings.md` |
| Codex `exec --json` event vocabulary — the parsing contract for `CodexSDKBridge` | `docs/sdk/codex-sdk.md` |
| `@openai/codex-sdk` library usage: `startThread`/`runStreamed`, `local_image`, the `env` escape hatch | `docs/sdk/codex-sdk-npm-demo.md` |
| `~/.codex/config.toml` keys — the biggest reference here | `docs/codex/docs/config.md` |
| What `read-only`/`workspace-write`/`danger-full-access` actually enforce | `docs/codex/docs/sandbox.md`, `execpolicy.md`, `windows_sandbox_security.md` |
| AGENTS.md discovery, custom prompts, slash-command surface | `docs/codex/docs/{agents_md,prompts,slash_commands}.md` |
| Auth failures ("API key not found"), ChatGPT-plan login | `docs/codex/docs/authentication.md` |

Two cautions. `docs/sdk/codex-cli-sdk.md` is the **legacy** TypeScript Codex README, banner-marked as superseded — consult it only for back-compat archaeology, and disbelieve its "Windows needs WSL2" claim. `docs/sdk/claude-sdk-permissions.md` says plan mode is unsupported in the SDK; `claude-agent-sdk.md` contradicts this and wins. Ignore `docs/codex/docs/{CLA,contributing,license,open-source-fund}.md` entirely — they govern OpenAI's own repo.

## Living architecture — read before changing the subsystem

| Before you touch | Read |
|---|---|
| The daemon request path: NDJSON protocol, runtime pooling, heartbeat/restart, per-request env isolation (`ai-bridge/daemon.js`, `persistent-query-service.js`, `provider/common/DaemonBridge.java`) | `docs/feat/daemon-architecture-refactor.md` |
| Anything streaming: `shouldOutputMessage`, `computeNovelDelta`, delta/snapshot throttles, `ReplayDeduplicator`, `useStreamingMessages` | `docs/fix/streaming-duplication-fix-2026-04-28.md` |
| Any webview render path — message-list derivation, merge logic, the caches in `App.tsx` | `docs/fix/PERFORMANCE_GUIDE.md` |
| Adding a provider, the unified permission model, sessionId↔threadId aliasing, event normalization | `docs/codex/MULTI-PROVIDER-ARCHITECTURE.md` |
| MCP marketplace / Copilot import, or relaxing any of its security controls | `docs/feat/mcp-marketplace.md` |
| On-demand SDK install, `~/.codemoss/dependencies/`, shared `window.*` callback chaining | `docs/feat/sdk-lazy-loading-architecture.md` |
| `App.tsx` orchestration, hook layout, data flow | `webview/src/ARCHITECTURE.md` |
| ChatInputBox: contenteditable, IME, `@`/`/`/`#` triggers, paste/drop | `webview/src/components/ChatInputBox/ARCHITECTURE.md` |
| Codex env-var injection and `PROTECTED_ENV_KEYS` | `docs/feat/env-vars-feature.md` |
| Slash-command system end to end (Java cache → JCEF → dropdown) | `docs/skills/SLASH_COMMANDS.md` |

The three most load-bearing are the daemon, streaming, and performance docs — together they cover the default message path end to end, and the streaming doc's maintainer notes ("维护者注意事项") encode regressions that recur when violated. Note it still has **open phases 2 and 3**: treat it as an active work queue, not just history.

`docs/feat` is per-subsystem and tells you *where things live*; `docs/fix` is per-incident and tells you *why the code is shaped defensively*. The split isn't clean — `rewind-feature-design.md` hides a post-mortem inside a feat doc, and the two `_GUIDE` files under `fix/` are standing references.

## Historical post-mortems — context, not instructions

Read these for the insight, never for the code snippets or line numbers, which are mostly dead:

- `docs/codex/CODEX-NO-RESPONSE-FIX.md` — durable insight: Codex genuinely emits no `agent_message` for pure information-gathering turns. Its `[CONTENT]`/`[CONTENT_DELTA]` protocol is gone (now structured `[MESSAGE]` JSON), and it is self-inconsistent on `maxTurns` (real value: 200).
- `docs/codex/DEBUG-OUTPUT-DISPLAY.md` — keep only the 7-hop data-flow trace; every symbol and line anchor it cites is gone from the tree.
- `docs/skills/*` (`avoiding-tmp-writes`, `tempdir-permission-sync`, `windows-cli-path-bug`, `cmdline-argument-escaping-bug`, `multimodal-permission-bug`) — five Windows/IDE-specific bug writeups whose *conclusions* still bind: pass args via stdin not the command line; use the SDK's built-in `cli.js` rather than resolving a system CLI; keep Node and Java pointed at one permission directory; `AsyncIterable` prompts suppress `canUseTool`. They all say `claude-bridge/` — read that as `ai-bridge/`.
- `docs/fix/CONFIG_AUDIT_REPORT.md` — problems 1–2 are fixed; **problem 3 is still open** (whole-object replace drops hand-edited `settings.json` keys, and no `PROTECTED_ENV_VARS` guard exists in `api-config.js`). Both config docs cite `test-env-loading.js` / `test-priority.js`, which do not exist.
- `docs/fix/CONFIG_PRIORITY_GUIDE.md` — one routing-relevant line: system env > `~/.claude/settings.json` > default. The rest is end-user tutorial.
- `docs/feat/rewind-feature-design.md` — the UI spec is aspirational and largely unbuilt; only the incident section is binding ("never pass a tool_result-only user uuid"). Rewind logic now lives in `ai-bridge/services/claude/message-rewind.js`.

## `docs/plans/` — an archive with two live tails

Everything here was written 2026-03-01…03-22 and nothing has been updated since, while the product shipped through v0.4.7. Do not read these as current state. Three specifics:

- **`2026-03-01-local-provider-snapshot-*.md` — never built.** Zero matches for its APIs anywhere in the tree. Actively misleading if read as reality.
- **`2026-03-07-project-level-prompts*.md` — shipped.** The code (`model/PromptScope.java`, `settings/{Abstract,Global,Project}PromptManager.java`, `PromptManagerFactory`) is the better reference now. `docs/testing/project-level-prompts-testing-checklist.md` is an unrun 80-case manual QA script — useful only as a regression pass if prompt scoping changes again.
- **`2026-03-12-large-file-refactor-priority-plan.md` and `2026-03-22-java-package-structure-reorganization-plan.md` are still authoritative** — they are the only written record of this repo's conventions and of unfinished work. See below.

---

# Conventions

## From the refactor plan (`docs/plans/2026-03-12-…`)

There is **no numeric file-size limit anywhere in this repo — do not invent one.** Acceptance is qualitative. The process rules are:

- Split one file at a time; multiple simultaneous splits make regressions unlocatable.
- Order: pure functions/helpers first (no protocol change) → services/hooks/support classes → finally the entry file, which keeps only orchestration.
- Behavior stays identical at every step; add tests following existing patterns as you go.
- Acceptance: message types and front/back protocols unchanged; responsibility boundaries clearer; new names state their purpose; no mechanical slicing into many still-incomprehensible files; tests cover the extracted pure functions and key branches.

## From the package plan (`docs/plans/2026-03-22-…`)

- **Group by domain, not by class-name suffix.** Do not collect all `*Service` / `*Manager` / `*Handler` into one directory.
- **`util/` is for stateless, cross-domain pure helpers only** — not a parking lot. Classes with business/config/theme/sound/language semantics belong in their domain package.
- **Moving a directory means updating every reference**, especially `src/main/resources/META-INF/plugin.xml` and anything resolving classes reflectively or by string name.
- Never mix a package move with a logic change, a protocol change, and a UI change in one round. If a class is strongly coupled to several packages, stop and record it as an open decision.

## Still-open work (verified against the tree)

- `provider/common/DaemonBridge.java` is **820 lines** — the last unsplit first-wave target (`DaemonProcessLauncher` / `DaemonProtocolClient` / `PendingRequestRegistry` / `DaemonHeartbeatMonitor` were planned, none exist).
- Package plan Phase 2 is half-done: `handler/{core,context,diff,file,history,provider}` exist, but `handler/{settings,skill,window,session}` were never created — ~28 handler classes still sit at `handler/` root.
- Phase 3 not started: `ThemeConfigService`, `FontConfigService`, `LanguageConfigService`, `SoundNotificationService`, `HtmlLoader`, `JBCefBrowserFactory` are all still in `util/`.
- The root package holds only `ClaudeSDKToolWindow.java`; the plan wants it under `ui/toolwindow/`.

## Project norms (`CONTRIBUTING.md`)

This is a personal project — there is no external contribution process.

- **English is the development language**: code, comments, commit messages, docs. Legacy Chinese comments and docs get migrated as they are touched.
- **Commit directly to `main`.** No feature branches, no pull requests, no review gate. CI runs on every push to any branch but blocks nothing.
- Commit messages follow conventional commits, as the existing history does: `feat(mcp):`, `fix(permission):`, `docs:`, `chore(release):`.
- `README.md` still describes the upstream release ritual (`/security-review` before each minor version, full audit every 10). Treat it as a habit worth keeping on permission, MCP, and env-var changes rather than a gate.

---

# Skills

## `.agents/skills/vercel-react-best-practices/`

Vendored from `vercel-labs/agent-skills` and pinned by `skills-lock.json` — **read-only; update by re-syncing, never by editing rules in place.** 70 React/Next.js performance rules in `rules/`, one file per rule, prefix-grouped: `async-` and `bundle-` (CRITICAL), `server-` (HIGH), `client-`, `rerender-`, `rendering-`, `js-`, `advanced-`.

Apply it when writing, reviewing, or refactoring anything under `webview/` — especially the chat render path, where `docs/fix/PERFORMANCE_GUIDE.md` documents real regressions this rule set would have prevented. Start from `SKILL.md`'s index, then open the specific `rules/<name>.md`. Two caveats: `SKILL.md` points at a compiled `AGENTS.md` that **does not exist here** (only `SKILL.md` + `rules/` were vendored), and the `server-*` / `bundle-*` rules assume Next.js — this is a Vite SPA in JCEF, so the `rerender-`, `rendering-`, `js-`, and `client-` groups are the ones that actually apply.

## Built-in skills worth reaching for

- `/security-review` — worth running on permission, MCP-marketplace, or env-var changes. This plugin brokers tool execution and API credentials, so those three areas carry real blast radius.
- `/code-review` — with no PR gate, this is now the only review this code gets. Run it before committing anything non-trivial.
- `verify` — nearly every change here spans Java, the webview, and the bridge, so tests alone rarely prove a change works; drive the real flow in `./gradlew runIde`.

## No `.claude/` directory exists

There are no project-level agents, hooks, or slash commands configured. Skills come only from `.agents/skills/`.

---

# Traps

- **Doc paths drift.** Verify a path before trusting it. Known-stale: everything under `docs/` still says `com.github.claudecodegui` — the Java package is now `com.github.ccxgui`, renamed so this plugin's classes do not collide with the upstream plugin it forked from. Also `CodemossSettingsService.java` is under `settings/`, `DependencyManager.java` under `dependency/`, rewind logic is in `message-rewind.js` (not `message-service.js`), and every `claude-bridge/` reference means `ai-bridge/`. Line-number anchors in docs are generally dead.
- **Class FQNs are load-bearing for coexistence.** IntelliJ keys `@Service` light services by class *name*, across the whole container — two installed plugins sharing a class FQN resolve to each other's instances and throw ClassCastException. That is why the package is `ccxgui`, and why nothing here may move back under a name upstream also uses.
- **Windows is the primary dev environment here.** Prefer `docs/codex/docs/windows_sandbox_security.md` over the generic sandbox doc, and remember the stdin-over-argv rule from `docs/skills/cmdline-argument-escaping-bug.md`.
- `docs/codex/CODEX-INTEGRATION-QUICKSTART.md` is a good orientation read, but its capability matrix is wrong: it claims Codex has no attachment support, while `ai-bridge/services/codex/message-service.js` builds `local_image` inputs today. Its `@openai/codex-sdk` version pin is a snapshot.
- The vendored `docs/codex/README.md` is OpenAI's repo README; its non-`docs/` relative links are broken here because those paths were never vendored.
