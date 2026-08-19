<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" width="220" alt="RelayAgent" />
  </picture>
</p>

<h1 align="center">RelayAgent</h1>

<p align="center"><b>The deterministic layer where humans and agents work together.</b></p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-5FA04E" alt="Node.js 22.6+" />
  <img src="https://img.shields.io/badge/status-seed-8B5CF6" alt="status: seed" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
</p>

RelayAgent is a personal substrate for agent packages that ship their own screens.

Agents are probabilistic. Collaboration is not. Every agent runtime today hands you a chat box, and a chat box has no surface a human can inspect, verify, or take over mid-flight. A package here ships a screen you can operate and verbs you can replay, judged by one manifest, so the same layer works for both the person and the agent.

One package = one agent + its screen. Installing one gives you software, not a chat window. The view is versioned as one body with its agent, judged by the same manifest, built at install, and hosted by the daemon at `/pkg/<name>/view/`. Chat and channels are just additional doors into that software.

One package is one directory. A single manifest (`relay.yaml`) declares everything the package is: its agents, verbs, screens, channels, services, triggers, and what it must not touch. The substrate reads nothing outside the manifest, installs fail-loud, keeps credentials in a vault, and records every inter-package connection as an auditable grant.

## Core concepts

| Concept | Meaning |
| --- | --- |
| Package | A directory with `relay.yaml`. The manifest is the source of truth for structure and paths; the tree is the source of truth for content. |
| Surfaces | How the package faces people. The centerpiece is `view`: a web UI the package ships, built at install, hosted by the daemon at `/pkg/<name>/view/`, and wired to its own agent's verbs with the package token. `chat` (direct conversation) and `channels` (Discord, Slack, and other adapters) are additional doors — a channel declares the *shape* of the credential it needs (`credential.fields`), so the console renders input fields instead of asking a human to hand-assemble JSON. `components` exports an npm package (source + `package.json`) that other packages' views consume as a build dependency via a components edge — the substrate packs it into a tgz at install, no registry involved. |
| Harness | The execution adapter bundled with the package that runs its agents. The system package bundles Claude Code, Codex, Kimi, and Pi adapters. Verbs: `session`, `setup`, `models`, `commands`, `info` (plus optional `login`, and `serve` — a resident session that takes turns over stdin instead of one process per turn). Contract conformance is judged by `relay harness-check`; the full contract lives in [docs/harness-protocol.md](docs/harness-protocol.md). A variant may declare `binary` (`{name, manager, package, version?}`) — then the substrate installs that CLI into its own prefix and puts it first on PATH, so a broken or missing global install on the host does not stop the package. |
| Agents | Persona (`AGENT.md`) plus skills, slash commands, and dispatch to subagents. Delivered to the harness as a neutral bundle; translation to native formats belongs to the adapter. `default: true` marks the landing agent. |
| Scripts | Verbs. `scripts/<name>.ts` default-exports `async (input, ctx) => JSON`. |
| Services | Exactly three shapes: `source` (its own body, container or process), `url` (a remote MCP endpoint; credentials attach only here), `dir` (a file resource). |
| Connector | A body-less package whose verbs call an external REST API directly. Top-level `auth` declares the credential shape only; the value sits in the vault and verbs pull it at call time via `ctx.credential()`. Mutually exclusive with `url` services. |
| Storage | `storage.buckets` — a file-bucket facade. Judged on a personal substrate, enforced by an org substrate. A different axis from a service's `disk`. |
| Triggers | Cron or event. Fires an agent with a prompt, or runs a script headless. `delivery: <channel>:<key>` runs the turn in that conversation's slot and posts the reply out through the channel adapter. |
| Missions | Q&A capabilities a package offers to other packages. |
| Edges | Declared dependencies on another package's tools, mission, or components. Declaration is an application; activation is a grant — for components the enforcement point is the view build, so a successful build resolution is what records the grant. |
| Workspace | The folder grant of a package: the cwd of its sessions, chosen at install (default `~/Relay/<name>`), recorded in the ledger. |
| Hooks | Session fences. `hooks.deny` lists paths the session's tool calls must not touch; adapters translate it into native hooks. The substrate always merges its own home (`~/.relay`) in. |
| Grants | Approvals recorded in the ledger. A grant can never exceed a declaration. |

## Quickstart

Requirements: Node.js 22.6 or later (the runner uses `--experimental-strip-types`), and a logged-in [Claude Code](https://claude.com/claude-code) CLI for the bundled harness. On macOS, credentials go to the Keychain; elsewhere a `0600` file vault is used.

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/relay.ts"

relay validate packages/system        # judge the manifest
relay install packages/system --ring0 --workspace ~   # management shell as ring-0, home folder as its workspace
relay daemon                          # API, services, triggers, console
```

The daemon listens on `http://127.0.0.1:4747` (change with `RELAY_PORT`). The console lives at `/pkg/system/view/`, the authoring playground at `/pkg/system/view/playground.html`. That console is itself the system package's view: the first piece of agent software running on the substrate.

Talk to the substrate:

```sh
relay run system                       # interactive session
relay run system "what is installed?"  # one-shot
```

Asking the system agent to build something new hands off to its `agent-builder` subagent, which reads the grammar, scaffolds into the edit layer (a draft), judges it with `draft-validate`, and publishes it with `draft-publish`. Installed packages are running binaries and are never edited in place: edits accumulate in a git-backed draft, and only a snapshot that passes judgment becomes a release. To edit by hand, open the Studio (`/studio`) from the console. GUI edits and agent edits share the same draft, the same diff, and the same publish gate.

## CLI

```
relay daemon                          start the substrate (API, services, triggers, console)
relay install <dir> [--ring0] [--workspace dir]  install a package (workspace = the folder grant)
relay ls | rm <name>                  list | remove
relay validate <dir>                  judge a manifest
relay build <pkg>                     rebuild surfaces.view.out
relay run <pkg> [prompt]              session (interactive without a prompt)
relay harness <pkg> [name]            list or switch harness variants
relay harness-check <pkg>             judge harness contract conformance
relay login <pkg> [--token]           harness login (when the adapter has a login verb)
relay model <pkg> [model]             show or set the model
relay effort <pkg> [level|off]        reasoning effort (adapters with the effort capability)
relay connect <pkg> <service>         paste a credential (vault / Keychain)
relay grant <consumer> <provider> --tools a,b | --mission m
```

## Anatomy of a package

```
my-package/
  relay.yaml                        the BOM: structure and paths
  assets/icon.svg
  agents/<name>/AGENT.md            persona
  agents/<name>/skills/<s>/SKILL.md skills
  agents/<name>/commands/<c>.md     slash commands
  scripts/<verb>.ts                 default export: async (input, ctx) => JSON
  surfaces/view/                    this package's screen (with `out`, built at install)
  channels/<name>/                  channel adapters (discord, slack, ...)
  harness/<name>/                   execution adapter, bundled with the package
  services/<name>/                  source services (container or process)
```

The grammar is [relay.manifest.yaml](relay.manifest.yaml), a JSON Schema with commentary. A full worked example manifest is [relay.yaml](relay.yaml) in the repo root. The management shell itself is a package: [packages/system](packages/system).

## Design principles

1. **The manifest is the BOM.** `relay.yaml` owns structure and paths, the tree owns content. A file unreachable from the manifest does not exist to the substrate.
2. **Fail-loud.** A mismatch between declaration and reality fails validation and install. There are no warnings, only judgments.
3. **Declarations are caps, grants are approvals.** `edges` and `dir` services in the manifest are applications. Activation happens at install or via `relay grant`, lands in the ledger, and can never exceed what was declared.
4. **Credentials never live in the tree.** Manifests declare only the shape of auth (`none`, `token`, `oauth`). Values sit in the vault: macOS Keychain, with a `0600` file fallback.
5. **Harness-neutral agents.** Agents ship as a neutral bundle (persona, skills, commands, meta). Translating it into any native format is entirely the adapter's job, so packages are not married to one CLI.
6. **Minimal ground.** A session stands on one granted folder: its workspace, confirmed at install. One more folder means a `dir` service, and paths a session must never touch go in `hooks.deny`. The substrate home (`~/.relay`) is denied to every session, always.

At the root of these six principles sits one premise: **everything can be expressed as an agent package.**

## State on disk

| Path | Purpose |
| --- | --- |
| `~/.relay/ledger.json` | installed packages and grants |
| `~/.relay/sessions/` | per-package session slots |
| `~/.relay/drafts/<name>/` | edit layer: git-backed working copies (the Studio and agent-builder write here) |
| `~/.relay/releases/<name>/<version>/` | published snapshots: the ledger path points at one of these (rollback = repoint) |
| `~/.relay/logs/*.jsonl` | event log |
| `~/.relay/vault.json` | credential fallback when Keychain is absent |
| `~/Relay/` | visible ground: default workspaces (`~/Relay/<name>`) |
| `~/Relay/.stage/` | file exchange stage between chat and sessions |
| `.env` (checkout root) | instance settings: `RELAY_HOME` (default `~/.relay`), `RELAY_PORT` (default 4747). Real shell env always wins. See [.env.example](.env.example) |
| `127.0.0.1:4747` | daemon API and console (default port) |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The highest-leverage contributions right now:

- **Harness adapters** for other coding agents (Gemini CLI, Qwen Code, local models): implement the verbs (`session`, `setup`, `models`, `commands`, `info`; optional `serve` for a resident session) over the neutral bundle. The bundled `claude-code` and `codex` adapters in [packages/system/harness](packages/system/harness) are the reference; `kimi` and `pi` show the minimal shape. Each is a single shell script.
- **Surface references**: example screens showing the contract where a view calls its own agent's verbs and the substrate API with the package token.
- **Channel adapters** (Telegram, email, web widget): map an external identity to a principal and dispatch through `RELAY_API`.
- **Service recipes**: working `url` service declarations (auth, verify) for popular SaaS.
- **Conformance checks**: extend the harness and channel contract checks judged by `relay harness-check`.
- **Docs and translations.**

Security issues go to [SECURITY.md](SECURITY.md), not the public issue tracker.

## License

[MIT](LICENSE).

Built by [RelayAX](https://relayax.com).
