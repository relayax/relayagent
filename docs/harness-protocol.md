# Harness adapter protocol

The contract between the substrate (`runner/`) and a harness adapter (`packages/*/harness/<name>/run`).
An adapter is a single executable (by convention a shell script) that translates the substrate's
neutral bundle into one native CLI session. The substrate never knows the CLI; the adapter never
reads outside the bundle. Conformance is judged by `relay harness-check`.

Current protocol version: **3**. Everything added since 2 is additive — a protocol-2 adapter keeps
working unchanged, and the substrate treats unknown events as opaque progress lines.

## Verbs

Invocation: `run <verb> [args…]`. Unknown verbs must exit non-zero.

| Verb | Required | Contract |
|---|---|---|
| `info` | yes | JSON on stdout: `{name, provider, protocol, verbs, capabilities, account}`. No side effects. |
| `setup` | yes | Readiness diagnosis. Exit 0 ready · 3 tool missing (prescribe install) · other non-zero: no credentials. Read-only. |
| `models` | yes | JSON array of model names on stdout. Never empty — degrade to documented aliases or a single guidance entry; reasons go to stderr. |
| `commands` | yes | JSON array `[{name, description?, tty?}]` of native slash commands. `tty: true` marks commands that only work in an interactive terminal. |
| `session` | yes | With a prompt argument: run exactly one turn through the envelope (below), then exit. Without a prompt: exec the native interactive TUI, inheriting the TTY. |
| `login` | optional | Interactive credential flow. Owns the TTY. `--switch` clears credentials first. |
| `serve` | optional | Resident session: the envelope stays up across turns; turns are injected over stdin. Declare it in `info.verbs` to opt in — the daemon prefers it when present. |

Environment: the substrate passes `RELAY_BUNDLE` (assembled bundle dir), `RELAY_NAME`, `RELAY_AGENT`,
`RELAY_SESSION`, `RELAY_API`, `RELAY_TOKEN`, `RELAY_PRINCIPAL`, and optionally `RELAY_MODEL` /
`RELAY_EFFORT`. `RELAY_*` is the substrate-to-adapter namespace; adapters must not mint their own
`RELAY_*` names except documented operator escape hatches (`RELAY_<CLI>_BIN`).

## The bundle

`RELAY_BUNDLE` is the assembled neutral bundle: `persona.md`, `skills/`, `commands/`,
`agents/<sub>.md` (delegate persona bodies), and `meta.json`. Translation into the native CLI
format is the adapter's job, and every translation artifact lands inside the bundle — never in
the user's config directory or the cwd.

**Session memory has one canon: `AGENTS.md` in the session's cwd** (`meta.cwd`). Memory is agent data, so it
lives in the granted folder (not in the tool's home, which nothing else can reach, and not in the
bundle, which rotation empties). Tools whose native convention already reads `AGENTS.md` from cwd
(codex, kimi) get it for free. A tool with a different convention shuttles via its own rail — the
claude-code adapter materializes a `CLAUDE.md` containing the single line `@AGENTS.md` before
spawn, and promotes a lone `CLAUDE.md` into the canon once (content moves to `AGENTS.md`, the
original becomes the import line). When both files exist independently the adapter must not touch
either. Home-scoped memory (`~/.claude` and kin) is the tool's own and never crosses — same axis
as credentials.

**Subagents are substrate-run.** `agents[].dispatch` names who an agent may delegate to; the
substrate serves that as the `agent_dispatch` MCP tool (gate = the declaration), runs the
subagent's turn in its **own session** — a first-class citizen of the session list, labeled
`↳ <name>`, prompt prefixed with the `[서브에이전트 · <pkg> · <name>]` marker the chat renders as
a delegation card — and returns the reply when it settles. Delegation sessions are keyed by
`(agent, target)`: naming the same `target` again lands in the same session and continues that
conversation (one turn per slot, so parallel delegation onto the same target is fenced off at the
door), `fresh: true` rotates the native pointer exactly like conversation reset, and a target-less
delegation falls back to a one-off session. Adapters must NOT translate subagents
into a native mechanism (claude's `--agents`/Task was retired 2026-08-20): native translation made
the same manifest mean different things per harness — in-context tasks on one CLI, silent
degradation on the rest — and hid the work from the session ledger. Adapters render the
delegation roster as a document section pointing at `agent_dispatch` (see the reference adapters);
a harness with no MCP (pi) states honestly that delegation is unreachable.

**The bundle is also the rotation boundary.** Native-session pointers (a claude session id, a
codex thread id — whatever the adapter needs to resume its own conversation) live inside the
bundle too. The substrate never learns their names; instead, conversation reset and harness
switching rotate the native context by **emptying the bundle** and letting the next turn's
assembly refill it. Anything an adapter stores outside the bundle survives that rotation and
becomes a stale-context bug. Native contexts never transfer across adapters — a codex thread
cannot resume a claude session — so on a harness switch the substrate rotates the pointers and
hands the new adapter a preamble synthesized from the substrate's own history ledger, which is
the conversation of record.

`meta.json`: `{pkg, agent, slot?, cwd, stage, hooks: {deny[]}, agents[], mcp, mcpServers?}`.
`cwd` is the folder the session stands on — the granted workspace plus `harness.workdir` when the
package declares one. It is deliberately not called `workspace`: with a `workdir` declared the two
are different folders, and one word for two values is how an adapter writes to the wrong place.
The MCP doors:

| Field | Shape | Contract |
|---|---|---|
| `mcp` | `{url, authorization}` | The substrate's single MCP door. `authorization` is the literal `Authorization` header value (may be empty). Adapters mount it under the server name `relay`. |
| `mcpServers` | `{<name>: {url, authorization?, headers?}}` | Additive — multiple doors. Each entry is one HTTP MCP server mounted under `<name>` exactly as given, so native tool names become `mcp__<name>__*` and the embedder controls the vocabulary its surfaces match on. `authorization` is the `Authorization` header value; `headers` is an opaque map of extra HTTP headers for doors that authenticate under other header names. Entries without a `url` are outside the contract and must be dropped, not guessed at. |

When `mcpServers` is present and non-empty the adapter prefers it and ignores `mcp`; absent, the
single `mcp` door applies unchanged. Embedders that emit `mcpServers` should keep emitting `mcp`
too, so older adapters keep their single door.

The substrate's own assembly obeys that rule from one place: `composeBundle` (`runner/runtime/harness.ts`)
always writes `mcp`, and adds `mcpServers` only when the session seam answers with doors
(`SessionIO.mcpServers` — it is handed the substrate's own `relay` door, so an implementation
chooses whether to carry it, rename it, or publish only its own). A single-user substrate answers
with none and its `meta.json` is byte-for-byte what it was before the field existed.

## The session envelope

`session <prompt>` and `serve` share one envelope. stdout is a JSONL event stream; stdin is a JSONL
control stream. Anything on stdout that is not a JSON object with a string `event` field is treated
as legacy plain output (protocol 1).

### Events (adapter → substrate, stdout)

| Event | Fields | Meaning |
|---|---|---|
| `delta` | `text` | Streamed fragment of the main-line answer. Subagent text must not be mixed in. Emit at whatever granularity the CLI gives you — the substrate is allowed to coalesce (below), so do not batch on the adapter's side. |
| `tool` | `status: "start"`, `id`, `name`, `detail?` (≤200 chars), `args?` (JSON string, ≤2 KB) | A tool call began. `id` pairs start/end; parallel calls are legal. |
| `tool` | `status: "end"`, `id`, `name`, `ok`, `result?` (≤8 KB) | The paired call finished. `result` is a display excerpt, not the full output. |
**`label` on a `tool` event is the substrate's, not the adapter's.** An adapter knows a tool's name
and nothing else about the ones the substrate serves — a verb slug like `orders-sync` says nothing,
and the adapter cannot look it up because it is not one of its CLI's tools. So the substrate attaches
a short name from its own `tools/list` before the event reaches the ledger and the clients. Adapters
must not emit `label`; a tool the substrate does not serve simply has none, and the client falls back
to what it did before. This is the only field the substrate adds to an event in flight, and it is
declared here rather than in the client contract on purpose: the envelope is the harness axis, and a
client-side field invented downstream is how two substrates end up meaning different things by it.

| `usage` | `input`, `output` | Live token ticker, throttled (≈250 ms). Estimates allowed between exact checkpoints; the final `reply.usage` is authoritative. |
| `task` | `id`, `status: "started"`, `note?` | A background task the model launched is now running. |
| `task` | `id`, `status: "done"`, `ok` | That background task settled. |
| `ask` | `id`, `questions` | The model asked the user a question (requires capability `ask`). Answer via the `answer` control line; the adapter must resolve unanswered asks itself (timeout with a sensible default) — an unanswered ask must never hang the turn forever. |
| `file` | `path` (stage-relative) | A successful write landed in the file-exchange stage. |
| `reply` | `text`, `session`, `model`, `usage {input, output, context_window, cache_read?, cache_creation?, cost_usd?}`, `context {input, window}`, `origin?: "task"` | Turn settlement. `usage` is the turn's billing ledger (cumulative); `context` is the occupancy of the conversation (last main-line state) — gauges must use `context`, not `usage`. `usage.input` stays cache-inclusive for compatibility; `cache_read` / `cache_creation` break the cached tokens out (non-cache input = `input − cache_read − cache_creation`) and `cost_usd` is the CLI's own cost ledger when it reports one — all three additive. `origin: "task"` marks a spontaneous continuation (below). |
| `error` | `message` | Turn failure. Exactly one of `reply`/`error` settles a turn. Failures are never disguised as text. |

### Control (substrate → adapter, stdin)

| Line | Meaning |
|---|---|
| `{"type":"turn","prompt":…}` | Inject the next turn (`serve` only). The substrate serializes turns per slot. |
| `{"type":"cancel"}` | Abort the in-flight turn. The adapter kills its CLI and settles with `error` + exit 130. |
| `{"type":"answer","id":…,"answers":[{question,selected[]}…]}` | Resolve a pending `ask`. Empty `answers` = the user cancelled. |
| EOF | Retire. `serve`: finish the in-flight turn, then drain (below), then exit 0. |

### Lifecycle

- **`session <prompt>`** — one injected turn, settle, exit. Background tasks are *not* drained
  (one-off contract): anything still running when the envelope retires may be killed. Background
  continuity belongs to resident sessions.
- **`serve`** — boot the CLI lazily on the first turn (resume recovery is confined to boot),
  stay resident between turns, exit on stdin EOF. If the CLI dies, exit non-zero; the substrate
  respawns a fresh resident on the next turn, resuming the conversation from disk. Residency is a
  projection: killing it at any point loses nothing but warmth.
- **Background tasks** — while `task`-started entries are unsettled, retirement defers force-kill
  timers and the substrate defers the idle TTL (drain). When a background task completes while the
  session is idle, the resulting spontaneous turn is emitted as a normal event stream ending in
  `reply {origin:"task"}`; the substrate appends it to the conversation history. A turn injected
  while a spontaneous turn is in flight must be queued behind it, never cross-wired.
- **Stall** — the substrate watches for event silence on an in-flight turn
  (`RELAY_TURN_STALL_S`, default 1200 s) and injects `cancel`. Adapters should therefore emit
  events as work happens, not in one batch at the end.
  A substrate that *also* reclaims the execution container (kills a pod, tears down a sandbox)
  must put that deadline **strictly after** the cancel deadline, with enough margin for the
  adapter to settle. Reclaiming at the same threshold races the `cancel` it just sent: the
  adapter is killed mid-settle and the user gets the substrate's guess ("stalled") instead of the
  adapter's honest `error`. Cancel is the first layer; reclamation is the backstop for an adapter
  that did not answer the cancel.
- **Delta coalescing** — a substrate **may** merge consecutive `delta` events into one before
  forwarding them onward, as long as it preserves order and concatenation (`text` joined in
  arrival order) and does not merge across a non-`delta` event. Adapters must not depend on 1:1
  delivery of the deltas they emit.
  *Why this is spelled out: an adapter naturally emits one `delta` per CLI token chunk, which is
  the right granularity at the source. But a substrate whose forwarding hop is expensive — a
  network POST per event, worse if that POST is synchronous on the read loop — turns that
  granularity into backpressure on the adapter's own stdout, and can stall the very turn it is
  reporting. Merging at block boundaries is the measured remedy (relayos, 2026-08). Leaving it
  unwritten made it look like a local hack rather than a contract-legal substrate choice, which
  is how such remedies get deleted by the next person.*

## Declarations

`info.protocol`: integer. 3 = the vocabulary above. `info.capabilities` is a closed vocabulary
judged by conformance: `cancel`, `vision`, `resume`, `effort`, `ask`, `tasks`. Declare only what is
physically implemented — the console enables UI per capability, and a declared-but-dead capability
is a broken screen.

## Reference

`packages/system/harness/claude-code/run` implements protocol 3 including `serve`, `ask`, and
`tasks`; `codex`, `kimi`, and `pi` in the same directory are protocol-2 per-turn adapters and show
the minimal shape.
