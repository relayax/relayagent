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

CI runs exactly this.

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

There is no release pipeline in this repo yet, so both steps are manual.

## Where the harness comes from

An agent package ships harness **adapters**, not the tools they drive. The adapter is a thin
translator; the CLI it drives (`claude`, `codex`, …) lives on the host. That is deliberate, and it
is the line between this substrate and the org one:

- **Here (single user):** install *elects* a harness — `electHarness` runs every declared variant's
  `setup` and takes the first that passes. A package works as long as **one** declared variant is
  ready on this machine. `requires.binaries` cannot express this: it demands all, and demanding
  `codex` would block a claude-only user's install.
- **Org substrate (relayos):** the harness comes from the **image** — the session pod is the
  harness, so the host is irrelevant. That is a property you buy, not one this repo reproduces.

`harness.variants[].dockerfile` was retired (2026-08-19). It had a schema entry, a TypeScript
field, and a line in the worked example — and no judgment, no consumer, and no place in the packed
artifact. Running the harness in a container is not a missing feature here; it is the wrong shape
for this substrate:

- **It turns the workspace from a folder into a resource.** Rule 6 says a session stands on one
  granted workspace folder, and the console's "데이터 폴더 열기" button exists to prove in one click
  that data lives in a folder you can open. Containerizing means bind mounts, uid mismatches, path
  translation (the agent sees `/workspace`, you see `~/Relay/<pkg>`), a mount per `dir` service, and
  `~/.relay` still denied. relayos already paid this: its workspace became a subPath inside a shared
  PVC with its own control-plane domain, junction records per (member × instance), and REST file
  access — after one architecture revision.
- **It would make Docker effectively mandatory.** Today Docker is optional and per-package: only
  `services[].dockerfile` needs it (`run.ts` skips container services when it is absent), and
  `packages/system` ships none. Every agent package must ship a harness — so a container harness
  would move Docker from optional to required for the whole product.

If a package declares `dockerfile` under a harness variant, validation now fails and says so.

## Language

Code comments and manifest commentary in this repo are written in Korean; public-facing docs
(READMEs, CONTRIBUTING, issue templates) are English-first with `ko` / `zh-CN` / `ja` translations.
Follow whichever convention the file you are editing already uses. Do not mass-translate a file
as a side effect of an unrelated change.

## Never

- Never commit a build artifact (`*.tsbuildinfo`, `surfaces/*/out`, `node_modules`).
- Never commit an absolute local path, a machine name, or a personal directory.
- Never commit anything under `~/.relay` (ledger, vault, sessions, logs) as a fixture.
