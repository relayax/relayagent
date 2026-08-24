# CLAUDE.md

Guidance for coding agents working **on the RelayAgent substrate itself** (this repository).
If you are looking for how to *use* RelayAgent, read [README.md](README.md).

## Premise

Everything can be expressed as an agent package. The substrate's job is to judge packages,
not to be clever about them.

## Layout

```
runner/                 the substrate (CLI + daemon). Plain .ts, run with --experimental-strip-types.
  relay.ts              CLI entry and command dispatch
  manifest.ts           relay.yaml parsing + judgment against relay.manifest.yaml
  installer.ts          install: judge, build surfaces, record grants in the ledger
  api.ts                daemon HTTP API + console hosting
  session.ts, run.ts    harness sessions
  draft.ts              edit layer (git-backed drafts) and publish gate
  scripts.ts            script (verb) execution
  vault.ts              credentials: macOS Keychain, 0600 file fallback
  state.ts, tick.ts     ledger, logs, triggers
  conform.ts            harness/channel contract conformance
  entry.ts              platform-neutral adapter execution (Windows runs entries via Git Bash)
  build.ts, login.ts, validate-all.ts

relay.manifest.yaml     the grammar: JSON Schema for relay.yaml, with commentary
relay.yaml              a full worked example manifest
docs/harness-protocol.md  the harness adapter contract (verbs, envelope events, control channel)
docs/verb-contract.md     the package verb contract (default export, ctx, optional meta export)
packages/system         the management shell, itself a package (console, studio, harness adapters)
lib/relayjs             browser-side client used by package views (+ `cn` styling util)
lib/relay-ui            blessed UI atom set for package views (shadcn-based, TS source consumed
                        via file: + transpilePackages; brand seam = src/tokens.css CSS variables)
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
   services. `~/.relay` is denied to every session, always.

## Working on the runner

- Target Node.js 22.6+. The runner is TypeScript executed directly via
  `node --experimental-strip-types`. That means **type-only syntax only**: no enums, no
  namespaces, no decorators, no parameter properties, nothing that needs emit.
- No build step and no runtime dependency beyond `yaml`. Do not add dependencies to the root
  `package.json` without a strong reason; a new dependency is a new thing every user must trust.
- Keep the CLI surface in `runner/relay.ts` a thin dispatcher. Logic belongs in the module.

## Changing the grammar

Any change to what `relay.yaml` may contain touches four places at once. Change all four in the
same commit or the change is incomplete:

1. `relay.manifest.yaml` (the schema and its commentary)
2. `runner/manifest.ts` (parsing and judgment)
3. `relay.yaml` (the worked example) and any affected `packages/*/relay.yaml`
4. The README tables, in **all four languages** (`README.md`, `.ko`, `.zh-CN`, `.ja`)

## Verify before you claim done

```sh
npm run validate    # every packages/* manifest must print a passing judgment
npm run typecheck
```

Touching anything under `lib/relayjs/src/` adds two more — the widget has its own tsconfig and
its own devDeps, so the root gates do not see it at all:

```sh
npm run typecheck:widget
npm run test:widget   # lib/relayjs/test — slot grammar + tab-shell transitions (node:test)
```

CI runs exactly these four.

## Two build artifacts the daemon serves — both gitignored, both must be rebuilt

**① The chat widget bundle.** The daemon serves it from `lib/relayjs/dist/`
(`/assets/chat-app.{js,css}`), and that directory is gitignored — a fresh clone does not have it:

```sh
npm run build:widget   # installs lib/relayjs devDeps, then esbuild → dist/
```

Touching anything under `lib/relayjs/src/` means rebuilding: the served bundle is the artifact,
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

Release artifacts are cut by `.github/workflows/release.yml`: pushing a `v*` tag (matching
the root package.json version — mismatch refuses the cut) runs the full judgment, builds the
widget bundle, and attaches `relay-chat-widget-<tag>.tgz` + `SHA256SUMS` to a GitHub Release.
The cut also packs `relay-contract-<tag>.tgz` (`@relay/contract` npm pack via
`npm run pack:contract` — the manifest judge, authority contract, and MCP gate baked to
CJS + d.ts **in the release workflow only**; tsc consumers typecheck but never emit raw `.ts`
out of node_modules, so embedders consume this build instead of vendoring the sources).
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

- Never commit a build artifact (`*.tsbuildinfo`, `surfaces/*/out`, `node_modules`).
- Never commit an absolute local path, a machine name, or a personal directory.
- Never commit anything under `~/.relay` (ledger, vault, sessions, logs) as a fixture.
