# Verb contract

The contract between the substrate (`runner/runtime/scripts.ts`) and a package verb — one TypeScript file
under `scripts.source`, named `<verb>.ts`. The file name is the verb's name. A session sees exactly
the verbs its agent declared in `agents[].scripts`, through the substrate's MCP door
(`tools/list`, `tools/call`).

## Execution

```ts
export default async function (input, ctx) { … }
```

The default export *is* the verb: it takes the call arguments (`input`, always an object) and the
substrate context (`ctx`), and returns JSON-serializable data. A file without a default export
fails loudly when called. Everything else a verb exports is optional.

**A verb runs in a worker thread, not in the daemon.** Each package tree (an installed release, or a
draft under preview) gets one worker, started lazily and retired quietly after the tree is replaced.
The verb's code — including its module top level, which `tools/list` imports to read `meta` — never
executes on the daemon's event loop, so a synchronous child process, a busy loop, or a `process.exit`
inside a verb stalls or kills only that package's worker; the daemon, its other packages, and every
session keep running. Everything on `ctx` that judges, resolves a credential, or carries identity
(`service(...).call/fetch/connected/fields`, `edge(...).call`, `dispatch`, `host.*`) is a door: the
worker sends the request to the substrate, which executes it on the real `ctx` and answers. What the
worker knows up front is coordinates only — `workspace`, the paths behind `ctx.dir(...)`, service
URLs, resolved edge providers — and no credential ever enters the thread. `fetch` bodies cross as
text or bytes (`string`, `Uint8Array`, `URLSearchParams`, `Blob`); a `Response` comes back with its
status, headers and body intact. A verb may keep working after it returned (a background finish that
knocks on `ctx` doors later); those doors stay open for an hour after the return, then refuse with a
reason. A run that exceeds `RELAY_SCRIPT_TIMEOUT_S` (default 1800) is killed together with its worker
and reported as such. A result that cannot cross the thread boundary — a function, a class instance
— is refused with a reason: the contract is JSON-serializable data.

`ctx`:

| Field | Contract |
|---|---|
| `pkg` | The verb's own package (install name). |
| `caller` | `{principal, agent?}` — who this run is for. The substrate fills it; a verb never mints it. |
| `dir(name)` | Absolute path of a declared `dir` service, with the install-time binding applied. Undeclared names throw. A verb runs inside the substrate, so it may hold a path; a session never does. |
| `service(name)` | `{url, call(tool, args), fetch(path, init?)}` for a declared service. `call` speaks MCP over HTTP (`url`, `source`) or the substrate's own file door (`dir`); `fetch` speaks REST inside the declared base (`api`). See below. |
| `dispatch(provider, mission, payload)` | a2a delegation. Requires an approved grant; returns the provider session's reply. |
| `host` | ring-0 only. The substrate bridge, capped by `host_methods`. `undefined` everywhere else. |

## Ground and folders

A verb stands on one folder: `ctx.workspace`, the package's workspace (`~/Relay/<pkg>` by default,
re-pointable per package in the ledger). It is the session's cwd and where work output belongs, and
it is created on first access.

The package's own screen reads that ground over HTTP: `GET /pkg/<install>/workspace/<path>` serves
one file from the workspace, read-only — jailed by the same judgment as a `dir` door (relative paths
only, no `..`, no symlink escape), dot-files and directories refused, revalidated on every request
(`ETag`/`Last-Modified` under `no-cache`) so a file overwritten in place is never served stale. It
exists because a verb returning file bodies inside JSON makes a list of rendered images weigh
megabytes. It is not a grant and declares nothing: the view and the workspace belong to the same
package.

A `dir` service is for the folders **outside** that ground. The workspace is where the agent stands
(it is the cwd, and the harness's native file tools simply reach it); a `dir` is something only the
package's **verbs** reach, through `ctx.service(name).call(…)`, and the session reaches it only
through those verbs. A session never sees a folder tool and never learns a `dir`'s path: handing
either to a session would invite it to bypass the verbs and walk the filesystem on its own terms,
and that path is nowhere at all on a substrate whose sessions live in pods. (Between 2026-08-25 and
2026-08-28 a declared folder also stood in the session as raw tools, `dir__<name>__*`, capped by
`agents[].dirs`. That was the one service a session consumed without a verb wrapping it — the shape
this contract otherwise forbids — and it is retired; declaring `agents[].dirs` now fails validation
with that prescription.)

The manifest gives the declaration two meanings by path shape: a relative path is inside the package
tree and owned by it, while a `~` path is a **request** — the install consent binds it, and the
binding is recorded in the ledger and merged, never dropped, across reinstalls. **The canon is the
name, not the path**: what is written in the manifest is the local default binding, `--bind` replaces
it, and an org substrate resolves the same name to its own volume coordinate (whether that folder is
one per instance or one per person is that substrate's policy, which is why this grammar has no word
for it). So `dir` is a coordinate and a grant, not a storage allocation; the only size axis in the
grammar is `services[].disk`, the persistent volume a container body mounts at `/data`.

Declaring your own workspace as a `~` dir is the shape to avoid. It reads as a request for a foreign
folder — grammatically identical to asking for someone else's ground — so the map and the permission
screen cannot tell a package's own data from data it borrowed. Use `ctx.workspace` for your own, and
a granted verb for anyone else's.

## Reaching a service

`relay.yaml` declares services in four forms, and `ctx.service(name)` is the single accessor for all
four. The handle carries both doors — `call` for MCP, `fetch` for REST — and calling the one a form
does not have throws with a message naming the other:

| Declared form | `ctx.service(name)` |
|---|---|
| `url` | The declared URL, called with the credential its `auth` block declares (resolved per call — an OAuth bundle rotates 60 s before expiry). `fetch` throws. |
| `api` | `fetch(path, init?)` against the declared REST base, with `Authorization` attached by the substrate from the service's own `auth` block — `<auth.scheme> <token>`, `Bearer` unless declared otherwise (Unsplash's `Client-ID`, for instance); same per-call resolution, same rotation. The verb never holds the credential, and a request resolving outside the declared base prefix throws — a foreign absolute URL, a `../` climb, and a root escape from a base that has a path are all the same judgment. That is what makes the manifest's base and the consent sheet's *goes out to this address* enforced rather than advertised. `call` throws. |
| `source` (`entry` or `dockerfile`) | The address the substrate knows the spawned body listens on. On a single-user substrate that is the declared `port` on loopback — the process form receives it as `env.PORT`, the container form maps `-p <port>:<port>`, so both look the same from the substrate's side. The MCP door is the root of that port: the declaration fixes a port and nothing else, so appending a path would invent grammar. A `source` service with no `port` throws. `fetch` throws. |
| `dir` | A file door the substrate stands up itself: `call("list"\|"read"\|"write"\|"remove", args)`, dispatched in-process (no network hop). Paths in the arguments are relative to the folder and nothing else — an absolute path, a `..` climb, and a symlink pointing outward are all refused by one judgment. `fetch` throws. Until 2026-08-25 this row read *a folder is not a door* and returned the caller to `ctx.dir(name)`; removing that exception is what makes the sentence above — one accessor for every form — true without an asterisk (the session-side folder tools that briefly accompanied it are retired again; see *Ground and folders*). The credential and identity axes are absent here on purpose: nothing goes out. |

One accessor for every form is deliberate. Credential and identity are attached where the call is
made; a second accessor for `source` bodies would be a second place to forget them, and the body most
likely to need identity — a database container narrowing rows per user — would be exactly the one
called without it. The same reason keeps `api` here rather than in a credential accessor of its own:
a package that reaches outward reaches through one door, and the credential contract lives on the
service it belongs to (`services[].auth`, vault coordinate `<pkg>/<service>`) — there is no second
home for it to drift into.

**A verb never sees the secret, but it can ask whether one is there.** `ctx.service(name).connected()`
answers whether the credential the service's `auth` block calls for is in the vault (`kind: none`, or
no `auth` at all, is always `true`); the `dir` and `source` forms have no credential axis and the call
throws. This is the door for an optional credential — a service declared `auth.required: false` is one
the package runs without, with only that feature off, and the verb decides by asking, not by receiving
a 401. When the declaration shapes the input as keyed fields (`auth.fields`), the one marked
`header: true` goes into `Authorization` and every field marked `secret` stays with the substrate; the
rest — an account id, a repository name, settings that travel with the credential but are not secret —
come back from `ctx.service(name).fields()`. People enter these on the console's connection screen
(`/connect?p=<install>&s=<service>`); a package screen only points there and never draws a key input
of its own.

**Address resolution is injectable.** `ServiceIO.body(pkg, service, port)` returns
`{url, authorization?}` or `null`, and the substrate's default answers loopback. An embedder whose
bodies live at cluster addresses supplies its own implementation to `makeCtx` / `runScript` and
patches no source. The credential half lives in the same seam because the `source` form has no
`auth` block to read: infrastructure credentials (a mesh token, for instance) can only be answered
by the infrastructure that issues them. When the seam returns none, the call carries none — the
body was already handed its credential at spawn time, in `RELAY_CRED_<NAME>`, from the same vault
coordinate (`<pkg>/<service>`).

## Reaching another package

`ctx.service(name)` reaches what this package declared for itself. Another package's data is reached
through one door only — a verb it granted you:

```ts
const answers = await ctx.edge("@scope/offer-workbook").call("answers-read", { offer });
```

`edges[]` is the cap and the ledger's grant is the approval. `ctx.edge(provider)` resolves the
provider by install name, by manifest name, or by the versioned reference written in
`edges[].provider`, so an author never has to know the install name; `call` refuses anything outside
the grant with `E_NO_GRANT`. A grant whose provider is no longer installed fails `E_NO_PROVIDER`
instead of dying on a missing record, and consumption that loops back into a package already on the
call stack fails `E_EDGE_CYCLE` with the chain printed — a mutual pair would otherwise burn the
stack and leave no cause behind.

The session tool (`edge__<provider>__<tool>`) and `ctx.edge` are two entrances to **one**
enforcement. Two entrances with two judgments is not a cap, it is a coincidence.

`edges[].agent_access` (tools form only) says what the consumer's **agent** may touch through that
edge. The default, `scripts-only`, means an edge tool always resolves to one of the provider's
verbs — a service the provider declared is consumed only through a verb that wraps it, on both
sides of the edge. `full` is the explicit opt-in for raw access: the remote-MCP tools the provider
listed in `services[].url.tools` also stand in the consumer's session as `edge__<provider>__<tool>`,
called with the provider's credential and the caller's identity, and the disclosure marks the edge
as raw. A grant cannot open a raw-only tool to a `scripts-only` consumer — `relay grant` refuses it
with the prescription — and a call that reaches one anyway fails `E_RAW_ACCESS`. When a verb and a
raw tool share a name, the verb wins. The provider's own sessions never see those raw tools: a
package consumes its own services through its verbs, always.

A borrowed verb is advertised the way the provider's own session sees it: the consumer's
`tools/list` carries the provider verb's `meta.description` and `meta.input` (see *Meta* below),
suffixed with which package it belongs to. A name alone makes a verb callable but not usable — the
session cannot know the argument shape of a verb it did not write. A provider whose manifest fails
judgment does not take the consumer's tool list down with it: that tool stands by name, and the
call itself is what fails loud.

**Do not point `dir` at another package's folder.** That shortcut is what this door exists to
remove, and it costs three things at once. The cap becomes the whole folder instead of a verb. The
provider's storage format gets copied into the consumer's source, where nothing judges it when the
provider changes it. And the coupling appears in no declaration — so the map, the permission screen,
and validation all report the two packages as unrelated while one of them silently depends on the
other. A folder is where a package keeps its **own** data; a verb is how anyone else reads it.

## Identity on outbound calls

Every MCP call the substrate makes on a package's behalf carries two axes, not one. The credential
answers *with what authority*; these headers answer *as whom*:

| Header | Value |
|---|---|
| `x-relay-principal` | The principal this run stands on (`ctx.caller.principal` for a verb) |
| `x-relay-agent` | The session's agent, omitted when the run has no agent (trigger, headless script call) |

The substrate injects them. A remote body that narrows rows by identity — a Postgres body binding
RLS to a session variable, for instance — cannot do so from the credential alone, and identity
carried by author code is identity that can be forgotten or forged. Verbs have no hand on these
headers.

Two paths reach a remote body, and they answer this question the same way:

- **`ctx.service(name).call(…)`** — the package calls its own declared service. Credential and
  identity both belong to that package's run.
- **Edge consumption** — one package consumes a tool the ledger granted it from another, whether
  through the session tool (`edge__<provider>__<tool>`) or a verb's `ctx.edge(provider).call(…)`. Here the axes split on purpose: **the credential is the provider's**,
  because the connection to the body is the provider's to own, while **the identity is the original
  caller's** — the principal that made the consumption and the consuming session's agent. Swapping in
  a provider identity would flatten every consumer's user into one, and the body's RLS would stop
  seeing the person it is supposed to narrow rows for. It is the same shape as the grant itself,
  which is recorded `consumer → provider`. Note that `x-relay-agent` is then a name from the
  *consumer's* vocabulary; a provider body must read it as identity, never as one of its own agents.

`api` services sit outside this axis on purpose. The upstream is a foreign REST API that does not
speak relay's vocabulary, so `x-relay-principal` would leak our principals to a third party and buy
no one anything. An `api` request carries the credential and nothing else.

a2a delegation (`host.dispatch`) does not carry identity this way: it spawns a full session on the
provider side that stands on the substrate's own principal, and the originating package appears only
as a delegation marker in the prompt. Carrying identity across that boundary is a session-spawn
contract question (`RELAY_PRINCIPAL`), not a header one.

## Meta (optional)

```ts
export const meta = {
  description: "…",                 // MCP tools/list description
  input:  { type: "object", … },    // JSON Schema literal
  output: { type: "object", … },    // optional
};
```

| Key | Contract |
|---|---|
| `description` | What `tools/list` shows the session — the verb's own and any session that borrows it through an edge. Absent → the substrate synthesizes `<pkg> 패키지의 <verb> 동사` (`edge 소비: <provider> 의 <verb>` when borrowed). |
| `input` | JSON Schema literal, published as the tool's `inputSchema`. Absent → the open schema `{type:"object", additionalProperties:true}`. |
| `output` | Accepted and ignored for now: MCP 2025-03-26 `tools/list` has no `outputSchema` slot. |

Rules:

- **The name is the file name.** `meta` has no `name` key — a name written twice is a name that
  can disagree with itself.
- **Absent meta is not an error.** A verb without `meta` behaves exactly as before, so adding the
  convention regresses nothing.
- **Unknown keys are ignored, not stripped.** `meta` is code, not a manifest: it is an
  advertisement, not a declaration the substrate judges against reality. The substrate reads the
  three keys above, judges nothing else, and passes the rest through untouched — so an embedder's
  own publish gate can define further keys and read them off the same loader without upstream
  knowing its vocabulary. Those keys mean nothing here; naming them in this contract would be how
  one substrate's dialect becomes everyone's grammar.
- **Schemas are advertised, never validated.** A validator is a dependency, and the zero-dependency
  rule outranks type advertisement. Judging the input stays the verb body's job.
- **Listing never calls a verb.** `tools/list` imports the module to read `meta` and never calls the
  default export. A module that fails to import is still listed by name; its condition is judged
  when it is called. Importing is not free of consequence, though: module top-level runs on every
  listing. Keep side effects inside the default export — a verb that opens a connection or writes
  a file at top level does it once per `tools/list`, not once per call.

## Reference

`packages/system/scripts/pkg-read.ts`, `draft-write.ts`, and `grant-approve.ts` carry `meta`; the
rest of that directory shows the meta-less shape, which the substrate still serves.
