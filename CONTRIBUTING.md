# Contributing to RelayAgent

Thanks for looking. RelayAgent is early, which means a small change can still move the shape of
the thing. Read this once before you open a PR.

## Ground rules

The substrate has six design principles (see the README). Two of them decide most review outcomes:

- **Fail-loud.** A mismatch between declaration and reality must fail validation or install.
  Do not add a warning, a fallback, or a silent degradation path. There are no warnings, only
  judgments. A PR that "gracefully continues" past a broken declaration will be rejected.
- **The manifest is the BOM.** `relay.yaml` owns structure and paths. If the runner reads a file
  the manifest did not declare, that is a bug, not a feature.

Credentials never live in the tree. Manifests declare only the shape of auth (`none`, `token`,
`oauth`); values go to the vault. Never put a real token in a manifest, fixture, log, or test.

## Setup

Requirements: Node.js 22.6 or later. The runner is plain TypeScript executed with
`--experimental-strip-types`, so the *runner* has no build step.

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/cli.ts"

npm run build:widget                       # chat widget bundle → chat/dist/
relay install packages/system --ring0       # management shell; --ring0 opens the host bridge
relay daemon
```

Two things the daemon serves are **build artifacts, and both are gitignored** — a fresh clone has
neither, and neither is built by CI:

- **the chat widget bundle** (`chat/dist/` → `/assets/chat-app.{js,css}`): `npm run build:widget`
- **a package's view** (`surfaces/view/out/` → `/pkg/<name>/view/`): `relay install` and
  `relay build <pkg>` bake it

Rebuild a view **only** through `relay build <pkg>`. A view is served under
`/pkg/<installName>/view/`, so Next must be built with `basePath` set to that prefix; the substrate
injects it as `RELAY_BASE_PATH` because the install name is only known at install time. Running
`npx next build` by hand leaves it empty, bakes every `/_next/...` URL root-absolute, and the page
404s its own stylesheet — with the build reporting success. The daemon now refuses to serve such a
view and says so, but the shortest path is not to make one.

Omitting `--ring0` on `packages/system` is the other easy trap: the management shell's `pkg-*`,
`draft-*`, `grant-*` and `release-*` verbs all need the host bridge, and without it the console
lists no packages and the studio answers `ring-0 전용`.

Because the runner is type-stripped rather than compiled, use **type-only TypeScript syntax**:
no enums, no namespaces, no decorators, no parameter properties.

## Before you open a PR

```sh
npm run typecheck
npm run validate     # every package in packages/ must pass judgment
```

Both must pass. CI runs exactly these.

If you edited a package view, rebuild it before validating — `npm run validate` also judges the
build artifact when it is present (stale relative to its source, or baked without the mount
prefix), and both judgments name the fix:

```sh
npm run relay -- build <pkg>
```

If your change touches what `relay.yaml` may contain, it must touch all four of these in the
same PR, or it is incomplete:

1. `relay.manifest.yaml` (the schema and its commentary)
2. `runner/supply/manifest.ts` (parsing and judgment)
3. `relay.yaml` and any affected `packages/*/relay.yaml`
4. The README tables in **all four languages** (`README.md`, `.ko`, `.zh-CN`, `.ja`)

## Where help is most useful

- **Harness adapters** for other coding agents (Gemini CLI, Qwen Code, local models). Implement
  the verbs `session`, `setup`, `models`, `commands`, `info` (plus optional `login`) over the
  neutral agent bundle. `packages/system/harness/claude-code` and `.../codex` are the reference;
  `kimi` and `pi` show the minimal shape. Each is a single shell script. Verify with
  `relay harness-check <pkg>`.
- **Surface references**: example screens showing a view calling its own agent's verbs and the
  substrate API with the package token.
- **Channel adapters** (Telegram, email, web widget): map an external identity to a principal and
  dispatch through `RELAY_API`.
- **Service recipes**: working `url` service declarations (auth, verify) for popular SaaS.
- **Conformance checks**: extend the harness and channel contract checks in `runner/supply/conform.ts`.
- **Docs and translations.**

## Scope

RelayAgent is a **personal** substrate: one person, one machine, one set of packages. Things a
company specifically needs (org account/OIDC integration, multi-user permission propagation and
governance, fleet-wide agent version management) are deliberately out of scope here. Proposals in
that direction will be closed as out of scope, not as bad ideas.

## Commits and PRs

- Conventional-ish prefixes are appreciated (`feat:`, `fix:`, `docs:`, `refactor:`).
- One concern per PR. A grammar change plus an unrelated refactor is two PRs.
- Describe what you ran to verify. "It works on my machine" is not verification.
- Discuss large or structural changes in an issue first so you do not burn a weekend on a
  direction that conflicts with the principles above.

## Reporting bugs

Open an issue with your OS, `node -v`, the exact command, and the full output. If validation or
install failed, paste the judgment verbatim; the message is the diagnosis.

**Security issues do not go in the issue tracker.** See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
