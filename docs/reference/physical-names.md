# Physical Names Reference

Notation generates stage-scoped cloud names for resources that declare `physicalName` rules, isolating environments in shared accounts and enabling create-first replacements without collisions.

## Name format

Generated names follow `<app>--<stage>--<base>-<instance><ending>`:

| Segment | Source |
| :--- | :--- |
| `<app>` | Application name from `NameScope` |
| `<stage>` | Deployment stage from `NameScope` |
| `<base>` | Normalized `rule.base(resourceId)` or `resourceId` |
| `<instance>` | Eight random lowercase hex characters per deploy instance |
| `<ending>` | Optional suffix from `rule.ending?.(params)` |

Because `NameSafe` forbids `--` in `app` and `stage`, the first `--` terminates `<app>` and the second `--` terminates `<stage>`. `<instance>` uses `GENERATED_INSTANCE_LENGTH = 8` via `crypto.getRandomValues` inside a durable deploy step, and `<ending>` defaults to `""` (such as `".fifo"` on FIFO SQS queues).

Schema fields configured with `physicalName` are omitted from `ConfigParams<T>` in TypeScript and cannot be supplied via untyped `config` or `deriveParams`. During `notation plan`, uncreated resources and replacements display `{ "$unknown": "after-apply" }` (`UNKNOWN_AFTER_APPLY`), while existing resources display their persisted name. Referencing a resource's own `physicalName` field via `resource.outputRef(field)` adds no dependency edge.

## Normalization rules

Identifiers follow three validation contracts before physical name generation:

| Identifier | Validation rule |
| :--- | :--- |
| Config `app` and `stage` | `1` to `32` chars matching `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| General resource `id` | `1` to `64` chars matching `^[A-Za-z0-9_-]+$` |
| Cloudflare Worker `id` | `1` to `63` chars matching `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` |

Config names disallow leading, trailing, or consecutive hyphens (`--`). General resource IDs enforce `ID_MAX_LENGTH = 64`, while Cloudflare Worker IDs require lowercase DNS-label characters.

When building `<base>`, `generatedNameBody` applies:

```ts [@notation/resource]
const base = (rule.base ? rule.base(resourceId) : resourceId)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
```

Provider `base` helpers (such as AWS `nameBase` and Cloudflare `workerNameRule.base`) strip the leading resource-type prefix (such as `lambda:` or `worker:`) before normalization. Collapsing non-alphanumeric runs to single `-` guarantees `<base>` contains no `--`.

## Length truncation

For generated names, `generatedNameBody` reserves `suffixLength = instance.length + 1 + ending.length` characters for `-${instance}${ending}` (`9` characters without an ending, `14` characters for `.fifo`). If `room = rule.maxLength - suffixLength < 1`, name generation throws. Otherwise `<app>--<stage>--<base>` is sliced to `room` characters and trailing `-` characters are trimmed before appending `-${instance}${ending}`.

For deterministic scoped names produced by `physicalName(scope, name, rule)`, names within `rule.maxLength` stay `<app>--<stage>--<name>`. Longer names are truncated to `rule.maxLength - 9`, trailing `[-_.]` characters are trimmed, and an 8-character lowercase hex FNV-1a hash is appended as `-${hash}`.

Provider schemas configure these `maxLength` limits:

| Resource | Max length |
| :--- | :--- |
| AWS Lambda function | `64` |
| AWS Lambda IAM role | `64` |
| AWS SQS queue | `80` |
| AWS API Gateway API | `128` |
| AWS EventBridge bus | `256` |
| AWS EventBridge rule | `64` |
| Cloudflare Worker | `54` |
| Cloudflare Account Token | `120` |
| Cloudflare Secrets Store Secret | `255` |

These limits apply to the generated name property (`FunctionName`, `RoleName`, `QueueName`, `Name`, or `ScriptName`). AWS SQS's `80`-character limit includes the `.fifo` suffix when enabled. Cloudflare Workers enforce `WORKER_NAME_MAX_LENGTH = 54` instead of `63` so preview URLs can prepend an 8-character version prefix and hyphen inside a 63-character DNS label.

## Uniqueness assertions

Notation checks identifier and name uniqueness across four layers before provisioning:

| Check | Enforcement |
| :--- | :--- |
| Resource IDs | Throws `Duplicate resource id: <id>` on duplicate graph IDs |
| Group and declaration IDs | Rejects duplicate IDs per `ResourceGroup` type or declaration helper |
| AWS parent-scoped names | `claimAwsName` rejects duplicate AWS names under the same parent |
| Provider account checks | Verifies account-unique resources without `physicalName` before creating |

Declaration helpers such as `$lambda`, `lambda()`, and `$durableObject` enforce unique IDs across the deployment. `claimAwsName` helpers such as `jwtAuthorizer()` report both conflicting call sites, and Cloudflare `KVNamespace` (`Title`) and `R2Bucket` (`BucketName`) check target-account uniqueness before creating.

## Explicit names

Top-level resources without `physicalName` (such as Cloudflare `R2Bucket` and `KVNamespace`) take their cloud name directly from `config`. Use `deployment()` from `@notation/core` to include `app` and `stage` when deploying multiple stages in one account:

```ts [infra/storage.ts]
import { deployment } from "@notation/core";
import { R2Bucket } from "@notation/cloudflare/resources";

const { app, stage } = deployment();

export const receiptsBucket = new R2Bucket("bucket:receipts", {
  config: {
    BucketName: `${app}--${stage}--receipts`,
    Jurisdiction: "default",
    StorageClass: "Standard",
  },
});
```

## Parent-scoped names

Resources whose cloud names only need uniqueness within a parent resource scope their identity or name to that parent:

| Resource | Parent scope |
| :--- | :--- |
| API Gateway JWT authorizer | `Name` scoped within `ApiId` |
| API Gateway route | `RouteKey` scoped within `ApiId` |
| EventBridge rule | Generated `Name` scoped alongside `EventBusName` |
| Lambda permission | Derived `StatementId` scoped by `FunctionName` |

JWT authorizer `Name` defaults to `id` (overridable via `name`) and is guarded per API by `claimAwsName`. Cloudflare Durable Object containers derive non-`--` application names via `containerApplicationName` (`<app>-<stage>-<base>-<sha256_8>`, prefixed with `c-` if starting with a digit) and image repositories via `containerRepositoryName` (`<app>--<stage>--<base>`).

## Replacement interaction

A resource's naming strategy determines whether an immutable change or `--replace` executes **create-first** or **delete-first**:

- **Create-first** – Used whenever a resource schema defines at least one `physicalName` param or sets `replaceCreatesFirst: true`. Deploy generates a fresh `-<instance>`, marks the old instance retired, creates the replacement alongside the live resource, updates dependents in place, and deletes retired instances at the end of deploy. If create fails, the previous resource remains live.
- **Delete-first** – Used for resources with fixed explicit names and no `replaceCreatesFirst` flag. Deploy deletes dependents listed in `blocksDeleteOf` and deletes the old resource before recreating it.

If a resource is replaced solely because an upstream dependency is replaced delete-first (`blocksDeleteOf` cascade), the planner overrides its order to `"delete-first"` regardless of whether it has a `physicalName`. See [Physical Names Internals](../internals/physical-names.md) for implementation details.
