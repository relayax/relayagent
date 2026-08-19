# Verb contract

The contract between the substrate (`runner/scripts.ts`) and a package verb — one TypeScript file
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

`ctx`:

| Field | Contract |
|---|---|
| `pkg` | The verb's own package (install name). |
| `caller` | `{principal, agent?}` — who this run is for. The substrate fills it; a verb never mints it. |
| `dir(name)` | Absolute path of a declared `dir` service, with the install-time binding applied. Undeclared names throw. |
| `service(name)` | `{url, call(tool, args)}` for a declared `url` **or** `source` service. `call` speaks MCP over HTTP. See below. |
| `credential()` | The connector-contract credential (top-level `auth`), pulled at request time. `null` when undeclared or unconnected. Never cached in env. |
| `dispatch(provider, mission, payload)` | a2a delegation. Requires an approved grant; returns the provider session's reply. |
| `host` | ring-0 only. The substrate bridge, capped by `host_methods`. `undefined` everywhere else. |

## Reaching a service

`relay.yaml` declares services in three forms, and `ctx.service(name)` is the single accessor for
the two that are bodies speaking MCP:

| Declared form | `ctx.service(name)` |
|---|---|
| `url` | The declared URL, called with the credential its `auth` block declares (resolved per call — an OAuth bundle rotates 60 s before expiry). |
| `source` (`entry` or `dockerfile`) | The address the substrate knows the spawned body listens on. On a single-user substrate that is the declared `port` on loopback — the process form receives it as `env.PORT`, the container form maps `-p <port>:<port>`, so both look the same from the substrate's side. The MCP door is the root of that port: the declaration fixes a port and nothing else, so appending a path would invent grammar. A `source` service with no `port` throws. |
| `dir` | Throws, with a message pointing at `ctx.dir(name)`. A folder is not a door. |

One accessor for both body forms is deliberate. Credential and identity are attached where the call
is made; a second accessor for `source` bodies would be a second place to forget them, and the body
most likely to need identity — a database container narrowing rows per user — would be exactly the
one called without it.

**Address resolution is injectable.** `ServiceIO.body(pkg, service, port)` returns
`{url, authorization?}` or `null`, and the substrate's default answers loopback. An embedder whose
bodies live at cluster addresses supplies its own implementation to `makeCtx` / `runScript` and
patches no source. The credential half lives in the same seam because the `source` form has no
`auth` block to read: infrastructure credentials (a mesh token, for instance) can only be answered
by the infrastructure that issues them. When the seam returns none, the call carries none — the
body was already handed its credential at spawn time, in `RELAY_CRED_<NAME>`, from the same vault
coordinate (`<pkg>/<service>`).

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
- **Edge consumption (`edge__<provider>__<tool>`)** — one package consumes a tool the ledger
  granted it from another. Here the axes split on purpose: **the credential is the provider's**,
  because the connection to the body is the provider's to own, while **the identity is the original
  caller's** — the principal that made the consumption and the consuming session's agent. Swapping in
  a provider identity would flatten every consumer's user into one, and the body's RLS would stop
  seeing the person it is supposed to narrow rows for. It is the same shape as the grant itself,
  which is recorded `consumer → provider`. Note that `x-relay-agent` is then a name from the
  *consumer's* vocabulary; a provider body must read it as identity, never as one of its own agents.

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
| `description` | What `tools/list` shows the session. Absent → the substrate synthesizes `<pkg> 패키지의 <verb> 동사`. |
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
