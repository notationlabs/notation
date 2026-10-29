# @notation/esbuild-plugins

## 0.15.0

### Minor Changes

- 16a0209: Lambda functions now need an explicit, name-safe `id`. Notation no longer derives one from the handler name and a hash of the code's file path.

  - `lambda()` requires `id`. It must be name-safe: 1 to 59 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names, and 59 leaves room for the `-role` suffix in the 64-character IAM role name. TypeScript rejects string literals that break the rule and values typed as plain `string`. At runtime, `lambda()` throws an error that names the bad ID.
  - The `config` export of a `.fn.ts` file requires `id`. Each handler gets the ID `<id>-<handler>`, which must also be name-safe. Compilation fails if `id` is missing or the resulting ID isn't name-safe.
  - Declaring two Lambda functions with the same ID in one deployment throws. IDs that differ only in case also clash, because IAM role names ignore case.
  - `@notation/aws/lambda` exports `NameSafe`, `isNameSafe` and `LAMBDA_ID_MAX_LENGTH`, and `@notation/resource` exports `getActiveResourceCollection`.

- 4fe4451: Paths are now relative to the project root (the nearest directory with a package.json, starting from the working directory), not the working directory. This covers deployment IDs, Lambda IDs, build output, the state database and the files that file and zip resources read. You can run the CLI from any folder inside the project and get the same result.

  This is a breaking change. Deployment IDs used to be absolute paths, so Notation will not find the state of existing deployments. Destroy them before upgrading, or redeploy and delete the old resources by hand.

### Patch Changes

- Updated dependencies [425f8ba]
- Updated dependencies [b290eb1]
- Updated dependencies [4fe4451]
- Updated dependencies [7a90e6b]
- Updated dependencies [6943418]
  - @notation/core@0.15.0

## 0.14.0

### Patch Changes

- @notation/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/core@0.11.1

## 0.11.0

### Patch Changes

- @notation/core@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/core@0.10.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1

## 0.6.0

### Minor Changes

- Support externally managed lambda modules

## 0.5.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Updated dependencies [2a6fc59]
  - @notation/core@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies
  - @notation/core@0.5.1

## 0.4.1

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/core@0.5.0

## 0.4.0

### Minor Changes

- Load infra in runtime modules

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.1

## 0.3.2

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/core@0.3.0
