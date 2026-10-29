# create-notation

## 0.2.1

### Patch Changes

- 16a0209: Lambda functions now need an explicit, name-safe `id`. Notation no longer derives one from the handler name and a hash of the code's file path.

  - `lambda()` requires `id`. It must be name-safe: 1 to 59 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names, and 59 leaves room for the `-role` suffix in the 64-character IAM role name. TypeScript rejects string literals that break the rule and values typed as plain `string`. At runtime, `lambda()` throws an error that names the bad ID.
  - The `config` export of a `.fn.ts` file requires `id`. Each handler gets the ID `<id>-<handler>`, which must also be name-safe. Compilation fails if `id` is missing or the resulting ID isn't name-safe.
  - Declaring two Lambda functions with the same ID in one deployment throws. IDs that differ only in case also clash, because IAM role names ignore case.
  - `@notation/aws/lambda` exports `NameSafe`, `isNameSafe` and `LAMBDA_ID_MAX_LENGTH`, and `@notation/resource` exports `getActiveResourceCollection`.

## 0.2.0

### Minor Changes

- Fix package versions

## 0.1.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

## 0.0.5

### Patch Changes

- Fix updating std.zip resource

## 0.0.3

### Patch Changes

- Add hashbang

## 0.0.2

### Patch Changes

- 10a8133: Migrate project scaffolding to create-notation

## 0.0.1

### Patch Changes

- Create package
