# Strip unsafe infra references from runtime bundles

**Idea:** When bundling a function's runtime code, allow it to import from `infra/` for types
without pulling infra (side-effectful, credential-bearing) code into the deployed artifact —
strip the unsafe references at build time.

Minimal shape (relative to main):

- New esbuild parser `packages/esbuild-plugins/src/parsers/remove-unsafe-references.ts`:
  walks the AST, keeps `infra/`-prefixed imports as type-only bindings, and emits
  `NotEmittedStatement` for everything else unsafe.
- TODO left in the original: resolve relative paths to validate the `infra/` location.

**Source branch (archaeology):** `infra-in-runtime` (~2023-12). Concept is still relevant to
the current `esbuild-plugins` / `.fn` macro pipeline.
