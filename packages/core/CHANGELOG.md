# @notation/core

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/reconciler@0.13.0
  - @notation/resource@0.13.0
  - @notation/state@0.13.0

## 0.12.0

### Minor Changes

- Add `notation plan` command backed by a serializable `Plan` and
  `Reconciler.plan()`, surfacing the deploy/destroy operations a run would
  perform before executing them.

  Also bumps dependencies to clear all outstanding security advisories and
  upgrades the core toolchain: TypeScript 6, Vite 8, Vitest 4, and glob 13.

### Patch Changes

- Updated dependencies
  - @notation/reconciler@0.12.0
  - @notation/resource@0.12.0
  - @notation/state@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file

## 0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

## 0.6.1

### Patch Changes

- Remove log

## 0.6.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

## 0.5.1

### Patch Changes

- Fix updating std.zip resource

## 0.5.0

### Minor Changes

- 5debdd1: Show deployed resource state in dashboard

## 0.4.1

### Patch Changes

- Removed dev artifacts from dist

## 0.4.0

### Minor Changes

- Stateful deployments

## 0.3.1

### Patch Changes

- b75f89b: Clean up path method

## 0.3.0

### Minor Changes

- Prepare for release
