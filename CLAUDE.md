# CLAUDE.md

Guidance for coding agents working **on the RelayAgent substrate itself** (this repository).
If you are looking for how to *use* RelayAgent, read [README.md](README.md).

## Premise

Everything can be expressed as an agent package. The substrate's job is to judge packages,
not to be clever about them.

## Layout

```
runner/                 the substrate (CLI + daemon). Plain .ts, run with --experimental-strip-types.
  cli.ts                terminal entry — a thin dispatcher, nothing else
  daemon.ts             HTTP entry — Host/Origin guards, route table, boot/shutdown order
  runtime/              makes a seated package live. One file per executable declaration.
    harness.ts            harness.variants  — bundle, spawn, envelope, residents
    scripts.ts            scripts.source    — the package backend (screen · agent · clock · peer call it);
                          builds ctx (judgment · credential · identity) and hands the run to a worker
    script-pool.ts        one worker thread per package tree; serves ctx doors the worker knocks on
    script-worker.ts      where a verb actually runs — no credential, no judgment, only a mirror ctx
    script-wire.ts        the message vocabulary between the two (types only)
    services.ts           services·channels — long-running child processes
    view.ts               surfaces.view     — build AND serve (one prefix predicate, one place)
    triggers.ts           triggers          — cron sweep and event fire
    tools.ts              agents·edges·missions — what a session sees, and its enforcement
    wire.ts               client protocol v1 (turns · sessions · upload · SSE)
    mcp.ts                MCP protocol (zero dependencies)
    oauth.ts              connector credential — PKCE/DCR flow, rotation at call time
    login.ts              harness login relayed through a pty (no token ever seen)
  supply/               knows what a package is, receives it, seats it, swaps the edition.
    manifest.ts           the grammar and its judgment (BOM)
    ledger.ts             install ledger — what is seated, what is granted
    install.ts            judge -> ledger -> artifacts, once
    binaries.ts           requires.binaries provisioning
    conform.ts            adapter contract check (install-time)
    draft.ts              edit layer (git-backed) and publish gate
    pack.ts sign.ts registry.ts store.ts   envelope, signature, remote shelf, its HTTP surface
  spawn.ts                the only place a process is started (Git Bash on Windows)
  vault.ts                the only place a secret is kept
  protocol.ts http.ts                      shared vocabulary · HTTP idioms
  authority.ts authority-contract.ts       the seam an embedder swaps

relay.manifest.yaml     the grammar: JSON Schema for relay.yaml, with commentary
relay.yaml              a full worked example manifest
docs/harness-protocol.md  the harness adapter contract (verbs, envelope events, control channel)
docs/verb-contract.md     the package verb contract (default export, ctx, optional meta export)
packages/system         the management shell, itself a package (console, studio, harness adapters)
chat/                   the chat widget and its client — the client half of the wire contract
                        (docs/client-protocol.md). Moves with the runner, not with a package.
assets/                 project logo
```

## Rules that are not negotiable

1. **The manifest is the BOM.** `relay.yaml` owns structure and paths; the tree owns content.
   Never make the runner read a path that the manifest does not declare.
2. **Fail-loud.** A mismatch between declaration and reality fails validation or install.
   Do not add warnings, fallbacks, or silent degradation. There are no warnings, only judgments.
3. **Declarations are caps, grants are approvals.** A grant recorded in the ledger can never
   exceed what the manifest declared. Never widen a grant at runtime.
4. **Credentials never live in the tree.** Manifests declare only the shape of auth
   (`none`, `token`, `oauth`). Values go through `runner/vault.ts`. Never write a secret to
   a manifest, a fixture, a log line, or a test.
5. **Harness-neutral agents.** Agents ship as a neutral bundle (persona, skills, commands, meta).
   Translation into a native CLI format belongs to the adapter in `packages/*/harness/<name>/`,
   never to the runner. Do not hardcode a model name, a vendor alias, or a CLI flag in `runner/`.
6. **Minimal ground.** A session stands on one granted workspace folder. Extra folders are `dir`
   services — reached only by the package's verbs (`ctx.service(<name>).call(…)`); a session never
   touches a folder directly, sees no folder tools, and never learns a folder's path. `~/.relay` is
   denied to every session, always, and install refuses a `dir` grant that resolves inside it (the
   judgment lives in `supply/install.ts`, not the manifest judge: `RELAY_HOME` is instance settings
   and the grammar must not know it).
7. **A session sees verbs, nothing else.** The MCP door lists the agent's own verbs and the verbs it
   borrows through granted edges. A service — folder, REST base, remote MCP, spawned body — is
   consumed by a verb that wraps it, never handed to a session raw. The one explicit exception is
   `edges[].agent_access: full`, which is opt-in, declared, and marked raw in the disclosure.

## Working on the runner

- Target Node.js 22.6+. The runner is TypeScript executed directly via
  `node --experimental-strip-types`. That means **type-only syntax only**: no enums, no
  namespaces, no decorators, no parameter properties, nothing that needs emit.
- No build step and no runtime dependency beyond `yaml`. Do not add dependencies to the root
  `package.json` without a strong reason; a new dependency is a new thing every user must trust.
- Keep the CLI surface in `runner/cli.ts` a thin dispatcher. Logic belongs in the module.
- `runtime/` is one file per executable manifest declaration — the grammar is the table of contents.
  `supply/` calls into `runtime/` (install builds a view); never the reverse, except ring-0's `host.install`.

## Changing the grammar

Any change to what `relay.yaml` may contain touches four places at once. Change all four in the
same commit or the change is incomplete:

1. `relay.manifest.yaml` (the schema and its commentary)
2. `runner/supply/manifest.ts` (parsing and judgment)
3. `relay.yaml` (the worked example) and any affected `packages/*/relay.yaml`
4. The README tables, in **all four languages** (`README.md`, `.ko`, `.zh-CN`, `.ja`)

## Verify before you claim done

```sh
npm run validate    # every packages/* manifest must print a passing judgment
npm run typecheck
npm test            # runner/**/*.test.ts — the embed seams, exercised by a real turn (node:test)
```

Touching anything under `chat/src/` adds two more — the widget has its own tsconfig and
its own devDeps, so the root gates do not see it at all:

```sh
npm run typecheck:widget
npm run test:widget   # chat/test — slot grammar + tab-shell transitions (node:test)
```

CI runs exactly these five.

## Two build artifacts the daemon serves — both gitignored, both must be rebuilt

**① The chat widget bundle.** The daemon serves it from `chat/dist/`
(`/assets/chat-app.{js,css}`), and that directory is gitignored — a fresh clone does not have it:

```sh
npm run build:widget   # installs chat/ devDeps, then esbuild → dist/
```

Touching anything under `chat/src/` means rebuilding: the served bundle is the artifact,
not the source.

**② Package view static exports.** `serveView` serves `surfaces/view/out/` when it exists.
So editing a view's source and not rebuilding means **the daemon keeps serving the old screen** —
and neither `typecheck` nor the manifest judgment looks at build output. This actually happened:
the atomic cut (`2639dae`) put the new widget wiring into the console layout, `out/` was never
rebuilt, and for two days the served document had the old wiring already gone and the new wiring
not yet there ("the chat widget is missing").

```sh
npm run relay -- build <pkg>
```

**Rebuild only through that command.** A view is served under `/pkg/<installName>/view/`, so Next
must be built with `basePath` set to that prefix — `next.config.mjs` reads it from
`RELAY_BASE_PATH`, which `buildView` injects because the install name is only known at install
time. Running `npx next build` by hand leaves `basePath` empty, every `/_next/...` URL is baked
root-absolute, and the served page 404s its own stylesheet and chunks: an unstyled console that
never hydrates. That failure looks nothing like a build error — the build passes.

`npm run validate` judges both halves: `out/` older than its source, and `out/` whose own assets
are addressed at daemon root instead of the mount. It stays silent when `out/` is absent — CI and
fresh clones don't build views, and absence is not staleness.

**③ Package component bundles.** `surfaces.components` exports a self-contained ESM bundle that
other packages' screens mount at runtime; declaring `out` makes install and publish bake it, and
the daemon serves `<source>/<out>/index.js` at `/pkg/<installName>/components/`. Same staleness
trap as ②, judged the same way (`staleBuild` against `index.js`), and the same remedy — rebuild
only through `npm run relay -- build <pkg>`. There is no basePath axis here: the bundle is reached
by an import map the daemon injects into the consuming document, so it never addresses its own
assets relative to a mount.

Release artifacts are cut by `.github/workflows/release.yml`: pushing a `v*` tag (matching
the root package.json version — mismatch refuses the cut) runs the full judgment, builds the
widget bundle, and attaches `relay-chat-widget-<tag>.tgz` + `SHA256SUMS` to a GitHub Release.
The cut also packs `relay-contract-<tag>.tgz` (`@relay/contract` npm pack via
`npm run pack:contract` — the manifest judge, authority contract, and MCP gate baked to
CJS + d.ts **in the release workflow only**; tsc consumers typecheck but never emit raw `.ts`
out of node_modules, so embedders consume this build instead of vendoring the sources)
and `relay-adapters-<tag>.tgz` (the harness variants and channel adapters under
`packages/system` — an embedder's authoring tree fills the declared paths by unpacking this,
not by keeping copies; the BOM only requires that a declared path exists).
Consumers (relayos 등 임베더) pin these artifacts by digest instead of vendoring sources.
Local rebuilds of the two artifacts above are still needed during development.

## Where the harness comes from

An agent package ships harness **adapters**, not the tools they drive. Where the tool comes from
is declared in `requires.binaries` — one vocabulary for "this executable must exist" (2026-08-19,
merged from a short-lived `harness.variants[].binary` object at the user's direction):

- `requires` is **AND**: when install finishes, everything in the list exists. An entry with only
  `install` is advisory-and-gate, as before (git — the substrate cannot install it for you).
- An entry with `manager` + `package` is a **recipe**: if the binary is missing, the substrate
  installs it under `~/.relay/bin/<pkg>/` and puts that directory first on PATH for the package's
  spawns. This is what makes AND affordable — before recipes, requiring `codex` would have blocked
  a claude-only user's install, which is why harness tools could never live in `requires`.
- A variant's `binary: <name>` is a **reference** to a requires entry, not a second declaration.
  It exists for one reason: when `setup` fails, the substrate promotes that entry to its own copy
  and retries once. Plain existence checks pass a gutted install (an npm wrapper whose native
  binary is gone — the real incident), so setup-failure is the only signal that catches it.
- Pinned `version` → the substrate's copy is canonical, host ignored (reproducibility).
  Unpinned → host first; nothing is downloaded that already works (eagerly provisioning all four
  system variants measured 921 MB).
- If the manager itself is absent, install fails loud with the entry's `install` guidance.
  The system package deliberately does not require `kimi` — that would make `uv` a product-wide
  prerequisite; the kimi variant remains host-elective. npm is already a de-facto prerequisite
  (view builds and component packing shell out to it).
- Removing a package removes its provisioned binaries.

Provisioning owns and pins; it does not isolate. Containerizing the harness was considered and
rejected (2026-08-19): the decisive cost is credentials — subscription logins live in the host
tool's Keychain, which adapters deliberately do not borrow, and relayos had to convert that axis
to a substrate-held token when it moved sessions into pods. A substrate-owned host copy keeps the
workspace a real folder and keeps the Keychain reachable. `harness.variants[].dockerfile` was
retired the same day; declaring it (or the old object-form `binary`) fails validation with a
prescription.

## Language

Code comments and manifest commentary in this repo are written in Korean; public-facing docs
(READMEs, CONTRIBUTING, issue templates) are English-first with `ko` / `zh-CN` / `ja` translations.
Follow whichever convention the file you are editing already uses. Do not mass-translate a file
as a side effect of an unrelated change.

## Never

- Never commit a build artifact (`*.tsbuildinfo`, `surfaces/*/out`, `surfaces/components/dist`, `node_modules`).
- Never commit an absolute local path, a machine name, or a personal directory.
- Never commit anything under `~/.relay` (ledger, vault, sessions, logs) as a fixture.
