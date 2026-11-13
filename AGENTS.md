# BELL Personal development

Complete the requested behaviour with the smallest clear change. Before editing,
understand the affected flow and inspect existing callers. Reuse existing code
first (the core services in `server/services.ts`, `DocTable`, `SourceSync`,
`runStructured`, the shared types), then the standard library and installed
dependencies. Add abstractions or dependencies only when the task needs them;
pin new dependencies to versions at least 14 days old. Prefer readable code
over compressed one-liners, and fix a shared root cause once.

The contract for features is `docs/ARCHITECTURE.md`. Read it before adding a
module, a table, a source or a model call.

## Product rules

- Today first: every module has a compact card on `#/today`; full pages only drill down.
- A missing or broken source never blanks the page. Sources without credentials show 尚未設定, not an error.
- AI proposes, the user decides: model output is stored as a suggestion and becomes a record only after a one-tap confirmation. Nothing is archived, sent or created automatically.
- Widgets fail independently (loading, error, empty, stale). Reversible actions are optimistic with an undo toast, not a confirm dialog.

## Copy

All user-facing text is Traditional Chinese for Taiwan (zh-TW): full-width
punctuation, `·` as the meta separator, `…` in progress text, buttons that
start with a verb, errors that say what failed and what to do. Never show
environment variable names, paths, stack traces or raw CLI output in the UI.
Error messages from the server are `{ error: string }` in zh-TW and pass
through `redact()`.

## Tests and checks

Use focused `node:test` tests next to the code (`*.test.ts`) for changed
behaviour, inject seams (`command`, `fetch`, `now`, `intervalMs`, `sleep`)
instead of spawning CLIs or touching the network, and run `npm run build`.
Run `npm test` when changing persistence, the security middleware, the AI
layer, sync, jobs or API contracts. Do not re-run expensive checks without a
new reason. Do not claim performance or token savings without measurements.

Never run a real model, Gmail, Calendar or LMS call from a test. Never use a
broad `pkill -f`: sibling BELL services on this host also run
`server/index.ts`; stop only the PID you started.

## Persisted data compatibility

- Every schema change is a new step appended to the right array in
  `server/db/schema.ts`. Never edit or reorder a step that may have run
  anywhere. Versions stay consecutive; when two branches append, the one
  merged second renumbers. A database newer than the code is refused at boot.
- New columns are nullable or have defaults. New JSON fields in a document are
  optional in the shared type and in the persisted zod schema, in the same
  commit, so older rows keep parsing (lenient reads skip, strict reads stop).
- `server/fixtures/personal.v1.sql` is frozen: later migrations must upgrade
  it and `server/db/database.test.ts` must keep reading it. Add a new frozen
  fixture when a migration changes data shape.
- Store instants as ISO UTC strings and days as local `YYYY-MM-DD` computed in
  `BELLPERSONAL_TZ` with `shared/time.ts`; the host clock is UTC.
- Credentials live only in the vault (`server/secrets/vault.ts`), never in
  SQLite, logs, API responses or the browser.

## Model calls

Only through `ctx.ai.runStructured()`: zero tools, a strict JSON schema, the
trust boundary in `server/prompts/boundary.ts`, untrusted data after it.
Never add `--bare` (it ignores the subscription login). Changing the Claude
argv requires a smoke test on this host and an update to the note below.

### Verified on host (2026-10-12, Claude Code 2.1.292, sonnet, effort low)

- The exact argv in `server/ai/agent-cli.ts` without `--safe-mode`
  (`-p --output-format stream-json --verbose --no-session-persistence
  --strict-mcp-config --setting-sources user --disable-slash-commands --model
  sonnet --effort low --tools "" --permission-mode dontAsk --json-schema
  '{"type":"object","properties":{"ok":{"type":"boolean"}},…}'`, prompt on
  stdin, `claudeEnvironment()` only) returned `result.subtype: "success"` with
  `structured_output: {"ok": true}` in 7.0 s. The user's SessionStart hook ran.
- The same argv plus `--safe-mode` also returned `structured_output:
  {"ok": true}` (3.5 s) and no hook ran, so `--safe-mode` is now part of the argv.
- `--json-schema` is delivered through a built-in `StructuredOutput` tool: the
  init event lists `tools: ["StructuredOutput"]`, the assistant calls it once
  and gets a `tool_result`. The isolation check allows exactly that tool, no
  MCP servers, no skills or slash commands, and only `@builtin` plugins.
- The recorded stream is `server/fixtures/claude-structured-output.jsonl`.
- `--max-turns` and `--permission-prompts` remain untested; do not add them
  without another smoke test. The Codex app-server fallback is ported from
  bell-explain but has not been exercised on this host; that includes the
  strict-mode `outputSchema` its `turn/start` now sends (`strictSchemaFor`,
  listed in codex-cli 0.159.0's `TurnStartParams`). Smoke-test it with the
  `{ok:boolean}` schema and the triage schema before relying on Codex.
