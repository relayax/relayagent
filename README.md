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
| Surfaces | How the package faces people. The centerpiece is `view`: a web UI the package ships, built at install, hosted by the daemon at `/pkg/<name>/view/`, and wired to its own agent's verbs with the package token. `channels` (Discord, Slack, and other adapters) are additional doors — a channel declares the *shape* of the credential it needs (`credential.fields`), so the console renders input fields instead of asking a human to hand-assemble JSON. `components` exports a **self-contained ESM bundle** — styles ride inside it — that other packages' screens mount at runtime: the substrate serves it at an address and injects an import map into the consuming document, so the consumer writes `import { mount } from "<provider name>"` and never assembles the address. Authoring it in React is free — React ends up inside the bundle, so the consumer needs no framework and no build. |
| Harness | The execution adapter bundled with the package that runs its agents. The system package bundles Claude Code, Codex, Kimi, and Pi adapters. Verbs: `session`, `setup`, `models`, `commands`, `info` (plus optional `login`, and `serve` — a resident session that takes turns over stdin instead of one process per turn). Contract conformance is judged by `relay harness-check`; the full contract lives in [docs/harness-protocol.md](docs/harness-protocol.md). The CLI a variant drives is declared in `requires.binaries` — with `manager` + `package` the substrate installs it itself when missing (into `~/.relay/bin/<pkg>/`, first on PATH), and a variant's `binary: <name>` references that entry so a broken host install is replaced on setup failure. |
| Agents | Persona (`AGENT.md`) plus skills, slash commands, dispatch to subagents, and an optional `greeting` — the opening line of an empty conversation, which belongs to the one speaking rather than to any door. Delivered to the harness as a neutral bundle; translation to native formats belongs to the adapter. `default: true` marks the landing agent — a package that declares agents must resolve one, by that flag or by an agent named after the package, and install refuses otherwise. A session stands on a persona, so a name outside `agents[]` never opens a turn. Direct conversation is not declared: an agent with no `view` gets a full-screen chat at `/pkg/<name>/view/` for free. |
| Scripts | Verbs. `scripts/<name>.ts` default-exports `async (input, ctx) => JSON`. `scripts.get` names the verbs that also answer a `GET` — an OAuth redirect, a webhook's verification challenge, a link someone opens; the query string is the input and a string return is the whole body. It is declared, never default: that door carries no `Origin` for the CSRF judgment to read, so it opens only where the author named it, and the consent sheet lists it as an inbound address. |
| Services | Four shapes: `source` (its own body, container or process), `url` (a remote MCP endpoint), `api` (a remote REST base), `dir` (a folder the substrate stands up as a door). Credentials attach only to the two that go outward (`url`, `api`). A `dir` is reached by name, never by path: a verb calls `ctx.service(<name>).call("list"|"read"|"write"|"remove", …)`; a session never touches a folder directly — it reaches one only through the verbs that wrap it. The declared path is the local default binding — install consent can rebind it, and an org substrate resolves the same name to its own volume coordinate. A credential declares the shape of its input (`auth.fields` — the same field vocabulary as a channel's `credential.fields`, plus `header: true` on the one token field that goes into `Authorization`), whether the package needs it (`auth.required`, default true; `false` means the package runs without it and only that feature stays off), and where to get it (`auth.help`). An `oauth` service has fields too, for what the login never asks about — an account id, a repository coordinate — carried inside the bundle it mints. `auth.accounts: true` says one service is reached as several accounts: the vault coordinate becomes `<pkg>/<service>@<account>`, the verb picks one with `ctx.service(<name>).account(<account>)` and lists them with `.accounts()`, and an unpicked handle refuses to call rather than choosing for you. The console's connection screen (`/connect`) draws every package's outward credentials from those declarations; a verb never holds the secret — it asks `ctx.service(<name>).connected()` and reads the non-secret fields through `.fields()`. |
| Connector | A body-less package whose verbs call an external REST API. It declares an `api` service — the REST base plus its `auth` shape. The value sits in the vault at `<pkg>/<service>` and the substrate attaches it per call, so a verb never holds the credential and cannot reach outside the declared base. `auth.scheme` names the `Authorization` prefix when the API is not `Bearer` (Unsplash's `Client-ID`, for instance); unset means `Bearer`. `auth.inject` moves the credential off the header entirely when the API wants it as a parameter — `{query: <name>}` or `{form: <name>}` — and `bases` declares the extra hosts one provider spreads across (a token exchange on another domain), each held to the same prefix judgment so the consent sheet still names every address the credential reaches. |
| Triggers | Cron or event. Fires an agent with a prompt, or runs a script headless. `delivery: <channel>:<key>` runs the turn in that conversation's slot and posts the reply out through the channel adapter. |
| Missions | Q&A capabilities a package offers to other packages. |
| Edges | Declared dependencies on another package's tools, mission, or components. Declaration is an application; activation is a grant — for components the grant is recorded when install resolves the edge, and the enforcement point is the import map the substrate injects into the consuming screen. `agent_access` (tools form only, default `scripts-only`) names what the consumer's agent may touch: under `scripts-only` an edge tool is always one of the provider's verbs; `full` also exposes, raw, the remote-MCP tools the provider declared in `services[].url.tools`, and the disclosure marks the edge as raw. |
| Workspace | The folder grant of a package: the cwd of its sessions, chosen at install (default `~/Relay/<name>`), recorded in the ledger. Its own view reads it at `GET /pkg/<name>/workspace/<path>` — read-only, jailed like a `dir` door, revalidated on every request. |
| Grants | Approvals recorded in the ledger. A grant can never exceed a declaration. |

## Quickstart

Requirements: Node.js 22.6 or later (the runner uses `--experimental-strip-types`), and a logged-in [Claude Code](https://claude.com/claude-code) CLI for the bundled harness. On macOS, credentials go to the Keychain; elsewhere a `0600` file vault is used.

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/cli.ts"

relay validate packages/system        # judge the manifest
relay install packages/system --ring0   # the management shell, as ring-0
relay daemon                          # API, services, triggers, console
```

The daemon listens on `http://127.0.0.1:4747` by default (`RELAY_PORT` picks another) and records its port in `RELAY_HOME/run/daemon.port`; the CLI follows that record, so a checkout only needs to know the home. The console lives at `/pkg/system/view/`, the authoring playground at `/pkg/system/view/playground.html`. That console is itself the system package's view: the first piece of agent software running on the substrate.

Talk to the substrate:

```sh
relay run system                       # interactive session
relay run system "what is installed?"  # one-shot
```

Asking the system agent to build something new hands off to its `agent-builder` subagent, which reads the grammar, scaffolds into the edit layer (a draft), judges it with `draft-validate`, and publishes it with `draft-publish`. Installed packages are running binaries and are never edited in place: edits accumulate in a git-backed draft, and only a snapshot that passes judgment becomes a release. To edit by hand, open the Studio (`/studio`) from the console. GUI edits and agent edits share the same draft, the same diff, and the same publish gate.

## CLI

```
relay daemon                          start the substrate (API, services, triggers, console)
relay install <dir> [--ring0] [--workspace <path>]  install a package (workspace = the folder grant)
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
relay suite ls | set <name> --members a,b [--hub h] | rm <name>   suites: sidebar folders
relay suite pack <name> [--out f] | import <f.relaypackages>      bake | receive a suite envelope
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
6. **Minimal ground.** A session stands on one granted folder: its workspace, confirmed at install. One more folder means a `dir` service — reached only by the package's verbs (`ctx.service`); a session never touches it directly and never learns its path. The substrate home (`~/.relay`) is denied to every session, always, and cannot be opened as a `dir` either: install refuses a folder grant pointing inside it.

At the root of these six principles sits one premise: **everything can be expressed as an agent package.**

## State on disk

| Path | Purpose |
| --- | --- |
| `~/.relay/ledger.json` | installed packages and grants |
| `~/.relay/sessions/` | per-package session slots |
| `~/.relay/releases/<name>/<version>/` | published snapshots: the ledger path points at one of these (rollback = repoint) |
| `~/.relay/logs/*.jsonl` | event log |
| `~/.relay/vault.json` | credential fallback when Keychain is absent |
| `~/Relay/` | visible ground: default workspaces (`~/Relay/<name>`) |
| `~/Relay/packages/<name>/` | edit layer: git-backed working copies (the Studio and agent-builder write here). Authoring is the point of this product, so it happens where you can open it — the running edition stays in `releases/`, out of reach. |
| `~/Relay/.stage/` | file exchange stage between chat and sessions |
| `.env` (checkout root) | instance settings: `RELAY_HOME` (default `~/.relay`), `RELAY_PORT` (only to *choose* a port — the CLI follows the running daemon). Real shell env always wins. See [.env.example](.env.example) |
| `~/.relay/run/daemon.{pid,port,runner}` | the running daemon's pid, port, and the runner it started from — written at start, followed by the CLI, removed at shutdown. A start from a different runner takes the old daemon over, so updating the app updates the daemon |
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
