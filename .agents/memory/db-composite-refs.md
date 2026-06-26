---
name: lib/db composite project refs
description: Why new schema exports aren't seen by api-server typecheck until db is rebuilt
---

`lib/db` is a TypeScript **composite** project that other artifacts (e.g. `api-server`)
consume via its emitted `dist/*.d.ts`, not its source.

**Rule:** After adding/changing exports in `lib/db/src/**` (new schema tables, etc.),
rebuild its declarations before typechecking any consumer:
`pnpm exec tsc --build lib/db/tsconfig.json --force`

**Why:** Consumers resolve `@workspace/db` against the built `dist` declarations. Until
`dist` is regenerated, a fresh export is invisible and the consumer's `tsc --noEmit`
reports "has no exported member …" even though the source is correct.

**How to apply:** Any time a cross-package type error references a symbol you just added
to `lib/db`, rebuild db first, then re-run the consumer typecheck.
