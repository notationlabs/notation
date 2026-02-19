---
type: epic
title: esbuild-split-module
created: "2026-02-26T00:56:19.617Z"
updated: "2026-02-26T00:56:19.617Z"
tasks:
  - TASK-010
  - TASK-011
priority: medium
estimate: medium
---
## Split one source file into separate infra and runtime builds via TypeScript AST analysis.

## Why

Developers want to co-locate related concerns in one file. A serverless function handler, its memory/timeout config, and its infrastructure metadata are all part of the same mental unit. But build systems need them separated — config goes to the infrastructure compiler, handler code goes to the runtime bundle. Today you either split them into separate files (losing co-location) or use convention-based hacks that break with any deviation.

`esbuild-split-module` solves this with static analysis. Write one file with both concerns. The plugin walks the TypeScript AST, identifies which statements belong to which "side" based on their import graph, and produces two clean outputs — no runtime overhead, no conventions beyond "imports from these paths are infrastructure."

This is prior art for a pattern that becomes more important in the agentic era: agents generate code in the way that makes semantic sense (co-located), and build tooling handles the mechanical separation. The agent does not need to know about your build pipeline file conventions.

---

## What to extract

### Core AST analysis (the real value)

| Current file | Function | Purpose |
|---|---|---|
| `parsers/remove-unsafe-references.ts` | `removeUnsafeReferences(source)` | Walks AST to identify imports from "safe" (infra) paths, removes every top-level statement that references any identifier NOT imported from those paths. |
| `parsers/remove-config-export.ts` | `removeConfigExport(source)` | AST transform that strips the `config` variable statement from the source. |
| `parsers/parse-fn-module.ts` | `parseFnModule(source)` | Parses exported declarations, finds the `config` export, extracts its primitive key-value pairs. |

### esbuild plugin wrappers

| Current file | Function | Purpose |
|---|---|---|
| `plugins/function-infra-plugin.ts` | `functionInfraPlugin()` | esbuild `onLoad` plugin that runs `removeUnsafeReferences` + `parseFnModule`, emits generated infra code. |
| `plugins/function-runtime-plugin.ts` | `functionRuntimePlugin()` | esbuild `onLoad` plugin that runs `removeConfigExport`, emits runtime-only code. |

## What to leave behind (Notation-specific)

1. The `.fn.ts` file naming convention — users must supply their own file filter.
2. The hardcoded `"config"` export name — make configurable.
3. The `"infra/"` import path prefix — must become user-configurable.
4. The `@notation/core` `filePaths` utility — output path computation.
5. The `config.service` parsing and `@notation/{platform}/{service}` import generation.
6. The reserved export names `["preload", "config"]` — should be user-defined.

## API surface

### Low-level: AST transforms (framework-agnostic)

```ts
import { stripStatements, extractExport } from "esbuild-split-module";

// Strip all statements referencing identifiers NOT from safe imports
const infraOnly = stripStatements(sourceCode, {
  keep: (importPath) => importPath.startsWith("infra/"),
});

// Remove a named export (for runtime builds)
const runtimeOnly = stripExport(sourceCode, "config");

// Parse a named export object literal into a plain object
const { value, raw } = extractExport(sourceCode, "config");
```

### High-level: esbuild plugins

```ts
import { splitModuleInfraPlugin, splitModuleRuntimePlugin } from "esbuild-split-module/esbuild";

splitModuleRuntimePlugin({
  filter: /\.fn\./,
  strip: ["config"],
})

splitModuleInfraPlugin({
  filter: /\.fn\./,
  safeImports: (path) => path.startsWith("infra/"),
  metadataExport: "config",
  codegen: ({ safeSrc, metadata, exports, filePath }) => {
    return generatedInfraCode;
  },
})
```

The key insight: the **AST analysis** is general-purpose. The **code generation** is always app-specific, so it stays in a callback.

## How "unsafe reference" stripping works

1. **Identify safe imports.** Walk all `ImportDeclaration` nodes. If the import source matches the user `safeImports` predicate, collect all imported identifiers into a `Set<string>`.
2. **Remove unsafe statements.** For every remaining top-level statement, recursively walk its AST subtree. If any identifier is a reference to a name not in the safe set, the entire statement is removed.
3. **Reference vs declaration.** The `isReference()` function distinguishes identifiers that use a value from identifiers that define one.
4. **Result.** A module containing only: safe imports, and statements that exclusively use identifiers from those imports.

## Dependencies

| Dependency | Purpose |
|---|---|
| `typescript` (^5.3.3) | AST parsing, transforms, printing. Core engine. |
| `esbuild` (^0.19.3) | Plugin API types. Peer dependency. |

## Rough scope

~570 lines total (320 source + 250 tests). 2-3 days for extraction, tests, and documentation.