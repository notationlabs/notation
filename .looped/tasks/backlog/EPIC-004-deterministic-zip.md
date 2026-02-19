---
type: epic
title: deterministic-zip
created: "2026-02-26T00:55:44.994Z"
updated: "2026-02-26T00:55:44.994Z"
tasks:
  - TASK-009
priority: medium
estimate: small
---
## Same input, same hash, every time.

## Why

You zip the same files twice. You get two different hashes. Your deployment pipeline thinks something changed. It re-uploads, re-deploys, restarts — all for nothing. This happens because ZIP files embed timestamps, and every tool gets this wrong by default.

This is a solved problem, but the solution is tribal knowledge — you have to know to pin mtimes, sort entries, fix compression level. `deterministic-zip` encodes that knowledge into two functions. If the input has not changed, the output is byte-identical. Your CI cache keys work. Your Lambda deploys skip unchanged functions. Your CloudFront invalidations only fire when content actually changed.

Small package, real savings — especially in pipelines that deploy dozens of functions.

---

## What to extract

| Source file | What to take |
|---|---|
| `packages/std.iac/src/utils/zip.ts` | The `zip.package()` core logic — `fflate.zipSync` with `{ level: 9, mtime: "0/0/00 00:00 PM" }` |
| `packages/std.iac/src/utils/zip.ts` | The `zip.getSourceSha256()` function |
| `packages/std.iac/src/utils/hash.ts` | Standalone `getSourceSha256`. Consolidate into the package. |

## What to leave behind

| Source file | Why |
|---|---|
| `zip.path()`, `zip.read()`, `zip.delete()` | Filesystem convenience wrappers specific to Notation IaC lifecycle |
| `packages/std.iac/src/resources/fs/zip.ts` | Notation IaC resource definition. Framework glue. |

## API surface

```ts
import { zipSync, sha256 } from "deterministic-zip";

const archive = zipSync({ "handler.js": sourceBuffer });
const hash = sha256(archive);
// If sourceBuffer has not changed, hash is always identical.

// Multiple files
const archive = zipSync({
  "index.js": indexBuffer,
  "lib/utils.js": utilsBuffer,
});

// Types
export type ZipInput = Record<string, Uint8Array>;
export function zipSync(files: ZipInput): Uint8Array;
export function sha256(data: Uint8Array | Buffer): string;
```

Two functions, one type. That is the entire public API.

## Key design decisions

1. **Pinned mtime is the core trick.** Sets every entry to DOS epoch (1980-01-01 00:00:00).
2. **Max compression (`level: 9`).** Pinning to max ensures consistency.
3. **Sorted entry keys.** Sort alphabetically before passing to fflate, so `{ a, b }` and `{ b, a }` produce the same archive.
4. **Buffer-in, buffer-out.** No filesystem I/O.
5. **SHA-256 as companion, not requirement.** Separate function.
6. **No streaming API.** `zipSync` is fine for deployment artifacts (<50MB).

## Dependencies

| Dependency | Version | Why |
|---|---|---|
| `fflate` | `0.8.1` | ZIP engine. ~29KB, zero deps, browser+Node compatible. |

`sha256` uses Node built-in `crypto`.

## Rough scope

~30-40 lines production code. ~40-60 lines tests. 1-2 hours including scaffolding.