# @notation/cli

## 0.14.0

### Minor Changes

- 9afdb3c: The reconciler now replaces a resource when a change cannot be applied as an update: a change to an `immutable`, `primaryKey` or `secondaryKey` param, or any change to a resource with no `update` operation. Plans gain `replace` and `drift-replace` decisions with the `replaceFields` that force them, and `notation plan` marks replacements with `-/+`. A replacement deletes the resource and then creates it again, and its dependents plan against unknown params. The comparison lives in `diffParams` in `@notation/resource`, so any engine planning a Notation resource reaches the same decision. Drift now compares only fields present both remotely and in the desired params, and an unset param is treated as absent rather than unknown. The update operation now fails for a resource with no `update`, where it used to skip the change silently.

### Patch Changes

- @notation/core@0.14.0
- @notation/dashboard@0.14.0
- @notation/esbuild-plugins@0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/core@0.13.0
  - @notation/dashboard@0.13.0
  - @notation/esbuild-plugins@0.13.0

## 0.12.0

### Minor Changes

- Add `notation plan` command backed by a serializable `Plan` and
  `Reconciler.plan()`, surfacing the deploy/destroy operations a run would
  perform before executing them.

  Also bumps dependencies to clear all outstanding security advisories and
  upgrades the core toolchain: TypeScript 6, Vite 8, Vitest 4, and glob 13.

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0
  - @notation/dashboard@0.12.0
  - @notation/esbuild-plugins@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/core@0.11.1
  - @notation/dashboard@0.11.1
  - @notation/esbuild-plugins@0.11.1

## 0.11.0

### Patch Changes

- @notation/core@0.11.0
- @notation/dashboard@0.11.0
- @notation/esbuild-plugins@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/core@0.10.0
  - @notation/dashboard@0.10.0
  - @notation/esbuild-plugins@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1
  - @notation/dashboard@0.3.0
  - @notation/esbuild-plugins@0.6.1

## 0.9.0

### Minor Changes

- Fix dashboard

### Patch Changes

- Updated dependencies
  - @notation/dashboard@0.3.0

## 0.8.0

### Minor Changes

- Support externally managed lambda modules

### Patch Changes

- Updated dependencies
  - @notation/esbuild-plugins@0.6.0

## 0.7.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Handle missing credentials
- Updated dependencies [2a6fc59]
  - @notation/esbuild-plugins@0.5.0
  - @notation/core@0.6.0
  - @notation/dashboard@0.2.0

## 0.6.2

### Patch Changes

- Fix updating std.zip resource
- Updated dependencies
  - @notation/core@0.5.1
  - @notation/dashboard@0.2.0
  - @notation/esbuild-plugins@0.4.2

## 0.6.1

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/dashboard@0.2.0
  - @notation/core@0.5.0
  - @notation/esbuild-plugins@0.4.1

## 0.6.0

### Minor Changes

- Load infra in runtime modules

### Patch Changes

- 10a8133: Migrate project scaffolding to create-notation
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @notation/dashboard@0.1.0
  - @notation/esbuild-plugins@0.4.0
  - @notation/core@0.4.1

## 0.5.0

### Minor Changes

- Stateful deployments

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.0
  - @notation/esbuild-plugins@0.3.2

## 0.4.2

### Patch Changes

- Fix tsconfig and getting started instruction

## 0.4.1

### Patch Changes

- 3b82ef1: Include templates in package bundle

## 0.4.0

### Minor Changes

- b75f89b: Add create app command

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1
  - @notation/esbuild-plugins@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/core@0.3.0
  - @notation/esbuild-plugins@0.3.0
