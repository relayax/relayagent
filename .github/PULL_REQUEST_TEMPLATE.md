## What this changes

<!-- One or two sentences. What is different after this PR? -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

## How I verified

```
npm run typecheck
npm run validate
```

<!-- Paste the relevant output, or describe the manual steps you ran. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run validate` passes (every package still passes judgment)
- [ ] Runner code uses type-only TypeScript syntax (no enums, namespaces, decorators, parameter properties)
- [ ] No credential, absolute local path, or build artifact is committed
- [ ] If this changes what `relay.yaml` may contain, all four are updated in this PR:
      `relay.manifest.yaml`, `runner/manifest.ts`, the example manifests, and the README tables in all four languages
- [ ] This stays inside the personal-substrate scope (no org account / multi-user governance features)
