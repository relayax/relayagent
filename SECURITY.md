# Security Policy

RelayAgent runs agents on your own machine, holds credentials in a vault, and grants sessions
access to real folders. A bug in the wrong place is not cosmetic. Please report it privately.

## Reporting a vulnerability

**Do not open a public issue.**

1. Preferred: GitHub's private reporting form —
   [Report a vulnerability](https://github.com/relayax/relayagent/security/advisories/new)
2. Or email **haemin@musibe.com** with `[relayagent security]` in the subject.

Please include:

- what an attacker can do, in one sentence
- OS, `node -v`, and the RelayAgent commit
- the smallest reproduction you have
- whether you have already disclosed it anywhere

We aim to acknowledge within 5 business days and to ship or explain a fix within 90 days.
Please give us that window before public disclosure. Credit is given in the release notes unless
you ask us not to.

## In scope

- Escaping the session's granted ground: a session touching a path outside its workspace or its
  declared `dir` services
- Reading `~/.relay` from a session (the substrate home is denied to every session, always)
- Credential exposure: a secret reaching the tree, a log, a manifest, an API response, or another
  package
- Grant escalation: an activated grant exceeding what the manifest declared, or a package reaching
  another package's tools or mission without a grant
- Bypassing the publish gate: a draft becoming a release without passing judgment
- Unauthenticated or cross-package access to the daemon API on `127.0.0.1:4747`, or to a
  package view's token
- Manifest parsing that leads to path traversal or arbitrary code execution at validate time

## Out of scope

- Anything requiring an attacker to already have your shell or your unlocked machine
- Vulnerabilities in the underlying coding agents (Claude Code, Codex, Kimi, Pi) or in models
  themselves. Report those upstream.
- A package you installed yourself doing what its manifest openly declares. Declarations are the
  contract; read them before installing.
- Prompt injection causing an agent to make a bad but *declared and granted* call. If it causes an
  *undeclared or ungranted* call, that is in scope and we want to hear about it.
- Missing hardening with no demonstrated impact

## Supported versions

RelayAgent is pre-1.0. Only `main` is supported. Fixes land on `main`; there are no backports yet.
