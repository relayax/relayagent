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

## The session envelope

`session <prompt>` and `serve` share one envelope. stdout is a JSONL event stream; stdin is a JSONL
control stream. Anything on stdout that is not a JSON object with a string `event` field is treated
as legacy plain output (protocol 1).

### Events (adapter → substrate, stdout)

| Event | Fields | Meaning |
|---|---|---|
| `delta` | `text` | Streamed fragment of the main-line answer. Subagent text must not be mixed in. |
| `tool` | `status: "start"`, `id`, `name`, `detail?` (≤200 chars), `args?` (JSON string, ≤2 KB) | A tool call began. `id` pairs start/end; parallel calls are legal. |
| `tool` | `status: "end"`, `id`, `name`, `ok`, `result?` (≤8 KB) | The paired call finished. `result` is a display excerpt, not the full output. |
| `usage` | `input`, `output` | Live token ticker, throttled (≈250 ms). Estimates allowed between exact checkpoints; the final `reply.usage` is authoritative. |
| `task` | `id`, `status: "started"`, `note?` | A background task the model launched is now running. |
| `task` | `id`, `status: "done"`, `ok` | That background task settled. |
| `ask` | `id`, `questions` | The model asked the user a question (requires capability `ask`). Answer via the `answer` control line; the adapter must resolve unanswered asks itself (timeout with a sensible default) — an unanswered ask must never hang the turn forever. |
| `file` | `path` (stage-relative) | A successful write landed in the file-exchange stage. |
| `reply` | `text`, `session`, `model`, `usage {input, output, context_window}`, `context {input, window}`, `origin?: "task"` | Turn settlement. `usage` is the turn's billing ledger (cumulative); `context` is the occupancy of the conversation (last main-line state) — gauges must use `context`, not `usage`. `origin: "task"` marks a spontaneous continuation (below). |
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

## Declarations

`info.protocol`: integer. 3 = the vocabulary above. `info.capabilities` is a closed vocabulary
judged by conformance: `cancel`, `vision`, `resume`, `effort`, `ask`, `tasks`. Declare only what is
physically implemented — the console enables UI per capability, and a declared-but-dead capability
is a broken screen.

## Reference

`packages/system/harness/claude-code/run` implements protocol 3 including `serve`, `ask`, and
`tasks`; `codex`, `kimi`, and `pi` in the same directory are protocol-2 per-turn adapters and show
the minimal shape.
