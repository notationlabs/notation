# Resource

Every cloud resource is represented as a typed, schema-driven object.

Source: `@notation/resource`

## Defining a resource

A resource is defined using the `defineResource` builder. The full chain looks like this:

```ts
import { defineResource } from "@notation/resource";
import { z } from "zod";

const LambdaFunction = defineResource<{
  Key: { FunctionName: string };
  CreateParams: {
    FunctionName: string;
    Runtime: string;
    Handler: string;
    Code: Buffer;
  };
  UpdateParams: { FunctionName: string };
  ReadResult: { FunctionArn: string };
}>({ type: "aws/lambda/LambdaFunction" })
  .defineSchema({
    // params – input properties
    FunctionName: {
      propertyType: "param",
      valueType: z.string(),
      presence: "required",
      immutable: true,
    },
    Runtime: {
      propertyType: "param",
      valueType: z.string(),
      presence: "required",
    },
    Handler: {
      propertyType: "param",
      valueType: z.string(),
      presence: "required",
    },
    MemorySize: {
      propertyType: "param",
      valueType: z.number(),
      presence: "optional",
    },

    // computed – populated by the cloud provider after creation
    FunctionArn: {
      propertyType: "computed",
      valueType: z.string(),
      presence: "required",
      primaryKey: true,
    },
  })
  .defineOperations({
    create: async (params) => {
      /* AWS SDK call, returns { FunctionArn } */
    },
    read: async (key) => {
      /* AWS SDK call */
    },
    delete: async (key, state) => {
      /* AWS SDK call */
    },
  });
```

### Step by step

**1. `defineResource(schema)(meta)`**

`schema` declares the API shape that the rest of the chain must conform to:

| Field          | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `Key`          | Fields that identify the resource for read/update/delete |
| `CreateParams` | Fields required to create the resource                   |
| `UpdateParams` | Fields that can be patched after creation                |
| `ReadResult`   | Fields returned by the cloud provider on read            |

`meta` defines runtime values for state tracking, reconciliation, and display

| Field  | Purpose                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| `type` | a `platform/service/ResourceName` string (e.g. `aws/lambda/LambdaFunction`). |

**2. `resource({ type })`** – `type` defines

**3. `defineSchema()`** – maps each field to a schema item. See [Schema items](#schema-items) below.

**4. `defineOperations()`** – CRUD handlers and error-handling config. See [Operations](#operations) below.

## Schema items

Every field in the schema is a `SchemaItem`. Each item has a `propertyType` that determines its role:

```ts
// param – input, set when defining the resource
FunctionName: { propertyType: "param", valueType: z.string(), presence: "required", immutable: true }

// computed – output, set by the cloud provider after creation
FunctionArn: { propertyType: "computed", valueType: z.string(), presence: "required", primaryKey: true }
```

### Common fields

All schema items carry these fields:

| Field          | Type                       | Description                                                      |
| -------------- | -------------------------- | ---------------------------------------------------------------- |
| `propertyType` | `"param" \| "computed"`    | Role of the field.                                               |
| `valueType`    | `ZodType`                  | Zod validator for type checking and serialisation.               |
| `presence`     | `"required" \| "optional"` | Whether the field must be provided.                              |
| `sensitive`    | `true?`                    | Redacted in logs.                                                |
| `hidden`       | `true?`                    | Excluded from CLI display and state output.                      |
| `volatile`     | `true?`                    | Expected to change between reads; excluded from diff comparison. |

### Flags by property type

**`param`**

- `immutable` – cannot change after creation (forces replacement).
- `primaryKey` / `secondaryKey` – together form the compound key used for read/update/delete.
- `collect` – makes the param collected, and combines what is contributed to it. See [Contributions](#contributions).

**`computed`**

- `primaryKey` – identifies the resource (e.g. `FunctionArn` returned by `create`).

## Operations

`defineOperations` accepts CRUD handlers and parameter derivation:

| Field          | Required | Signature / Description                                                                                                                                                                                       |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`       | yes      | `(params, context?, token?) => Promise<ComputedPrimaryKey<S>>` – create the resource, return its computed key. `token` is unique to the attempt.                                                              |
| `find`         | no       | `(params, token) => Promise<ComputedPrimaryKey<S>>` – find the resource that the create attempt with `token` made, or throw `ResourceNotFoundError`. See [Unknown create outcomes](#unknown-create-outcomes). |
| `read`         | no       | `(key, context?) => Promise<Result<S>>` – return the remote object or throw `ResourceNotFoundError`.                                                                                                          |
| `update`       | no       | `(key, patch, params, state, context?) => Promise<void>` – apply a partial update.                                                                                                                            |
| `delete`       | yes      | `(key, state, context?) => Promise<void>` – ensure the resource is absent. Implementations must also succeed when the remote resource is already gone.                                                        |
| `deriveParams` | no       | Computes intrinsic derived params from config (not dependency-aware).                                                                                                                                         |

The reconciler records params, results and state, so each must be a durable value as yieldstar 0.8.2 defines it: `null`, a boolean, number, string or `bigint`, `undefined`, a `Date`, an `Error`, or an array, `Map`, `Set` or plain object of these. From the result of `create` and `read`, the reconciler keeps only the properties the schema declares. A `Buffer` or another class instance in a schema value type becomes `never`, so a handler that returns one does not compile. Return a file as its path and hash instead of its bytes.

### Operation errors

Import the errors from `@notation/resource`:

```ts
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
```

The constructors are:

```ts
new ResourceNotFoundError(message: string, options?: { cause?: unknown });

new ResourceOperationPendingError(message: string, {
  retryAfterMs: number;
  callbackContext?: Readonly<DurableObject>;
  cause?: unknown;
});

new ResourceCreationUnknownError(message: string, options?: { cause?: unknown });
```

| Handler result                                                                        | Meaning                                                                                   | What the reconciler does                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return normally                                                                       | The operation finished.                                                                   | Continues the deployment.                                                                                                                                                                                                                           |
| `throw new ResourceNotFoundError(message, { cause })`                                 | `read` or `delete` found no resource for the given key.                                   | From `read`, treats the resource as absent during planning and drift detection; a read after create or update fails because that operation claimed to have finished. From `delete`, treats the delete as complete, since absence is its goal state. |
| `throw new ResourceOperationPendingError(message, { retryAfterMs, callbackContext })` | The operation has not finished.                                                           | Waits for `retryAfterMs`, then calls the same handler again. It passes `callbackContext` as the handler's final argument.                                                                                                                           |
| `throw new ResourceCreationUnknownError(message, { cause })`                          | `create` cannot tell whether the provider made the resource, for example after a timeout. | Looks the resource up, as described in [Unknown create outcomes](#unknown-create-outcomes).                                                                                                                                                         |
| Throw any other error                                                                 | The operation failed.                                                                     | Stops the deployment.                                                                                                                                                                                                                               |

`ResourceNotFoundError` means the resource is absent wherever it is thrown. A `delete` handler may either catch the provider's missing-resource error and return normally, or translate it to `ResourceNotFoundError`; both count as success.

`ResourceOperationPendingError` may be thrown by `create`, `read`, `update`, or `delete`. Its options are:

| Option            | Type                      | Required | Meaning                                                                                                                                                                  |
| ----------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retryAfterMs`    | `number`                  | yes      | Milliseconds to wait. It must be zero or greater.                                                                                                                        |
| `callbackContext` | `Readonly<DurableObject>` | no       | Data for the next attempt. The reconciler records it with the error. If it holds a value that is not durable, such as a `Buffer`, the next attempt receives `undefined`. |
| `cause`           | `unknown`                 | no       | The provider error that caused this result.                                                                                                                              |

The default limit is 30 attempts. Set `maxOperationAttempts` in the deploy, plan, or destroy options to change it. Reaching the limit fails the operation.

```ts
read: async (key, context) => {
  try {
    return await client.send(new GetResourceCommand(key));
  } catch (error) {
    if (error instanceof ResourceMissingException) {
      throw new ResourceNotFoundError("Resource was not found", {
        cause: error,
      });
    }
    if (error instanceof OperationInProgressException) {
      throw new ResourceOperationPendingError("Resource is not ready", {
        retryAfterMs: 1_000,
        callbackContext: { requestId: error.requestId },
        cause: error,
      });
    }
    throw error;
  }
};
```

### Unknown create outcomes

The outcome of a create attempt is unknown when the process stops after `create` returns and before the reconciler records the result, or when `create` throws `ResourceCreationUnknownError`. The reconciler then looks the resource up before it calls `create` again:

1. A resource with `find` is found by the attempt's token. `create` must record the token on the remote resource, for example as a tag, so that `find` can search for it.
2. A resource with `read`, whose key is made of params, is read by the key it would have.
3. Any other resource cannot be found. The reconciler calls `create` again after a stopped process, and fails the deployment on a `ResourceCreationUnknownError`.

When a lookup finds the resource, the reconciler uses what it found as the result of `create`. When it throws, the reconciler looks again after one second. When the outcome is still unknown after 10 attempts, or after `maxOperationAttempts` when it is lower, the deployment fails with a `WorkflowEffectError` with code `EFFECT_OUTCOME_UNKNOWN`.

A lookup must not report a resource as absent while a create for it can still finish. A provider whose reads are eventually consistent can break this rule.

```ts
create: async (params, _context, token) => {
  try {
    const result = await client.send(
      new CreateApiCommand({ ...params, Tags: { ...params.Tags, [TOKEN_TAG]: token! } }),
    );
    return { ApiId: result.ApiId! };
  } catch (error) {
    if (isTimeout(error)) {
      throw new ResourceCreationUnknownError("CreateApi timed out", { cause: error });
    }
    throw error;
  }
},
find: async (_params, token) => {
  const api = await findApiByTag(TOKEN_TAG, token);
  if (!api) throw new ResourceNotFoundError("No API has the token");
  return { ApiId: api.ApiId! };
},
```

In `@notation/aws.iac`, `awsCreate` wraps a `create` handler and throws `ResourceCreationUnknownError` when an AWS call times out, loses its connection or gets a server error.

## Dependencies

A resource can depend on other resources. After `defineOperations`, chain `requireDependencies` and `deriveParams`:

```ts
const LambdaIntegration = defineResource<{ ... }>({ type: "aws/apiGateway/LambdaIntegration" })
  .defineSchema({ ... })
  .defineOperations({ ... })
  .requireDependencies<{ api: ApiResource; lambda: LambdaResource }>()
  .deriveParams(({ id, config, deps }) => ({
    IntegrationUri: deps.lambda.output.FunctionArn,
    ApiId: deps.api.output.ApiId,
  }));
```

`requireDependencies` declares typed dependency slots. `deriveParams` receives `{ id, config, deps }` and returns properties computed from dependency outputs. At deploy it runs after its dependencies have been provisioned, with their real outputs. At plan, a dependency that has no output yet throws `PendingOutput` when `deriveParams` reads its `output`; see [Unknown values](reconciler.md#unknown-values).

A resource takes its ID first, then its config and dependencies:

```ts
const integration = new LambdaIntegration("todo-api-get-todos-integration", {
  dependencies: { api, lambda },
});
```

The ID keys the resource in state, so keep it stable. The second argument can be left out when neither `config` nor `dependencies` has a required property.

Dependencies also determine deployment order: a resource is not created until all its dependencies exist.

`resource.dependOn(other)` adds a dependency after construction. It orders the deploy and is recorded in state, but `deriveParams` does not receive it. Like `contribute`, it throws once evaluation ends; see [Lifetime](#lifetime).

## Output values

An output, such as a queue's ARN, does not exist until the provider creates the resource. Infra code still needs to put it in another resource's config. `resource.outputValue(key)` returns a token that stands for the output, typed as the output:

```ts [packages/aws/src/sqs/queue.ts]
const queue = new aws.sqs.Queue("orders-queue", {
  config: { QueueName: "orders" },
});

const mapping = new aws.lambda.LambdaEventSourceMapping("orders-mapping", {
  config: { EventSourceArn: queue.outputValue("QueueArn") },
});
```

The token has two effects:

- `mapping` depends on `queue`, so the queue deploys first.
- Deploy replaces the token with the queue's real ARN before it calls the provider for `mapping`. A token for a number becomes a number.

**A token can only be placed whole.** Turning it into a string throws `OutputValueStringError`, whether in a template string, with `String()` or with `JSON.stringify`. This matters because a string such as `` `${arn}/*` `` would hide the token, and plan could not tell that the value is unknown. It follows that a token cannot be a map key: key the entry by something known now, and put the token inside it. To compute with an output, use `deriveParams` or a [function contribution](#function-contributions), which receive the real output at deploy.

## Contributions

Some params take values from several places. For example, a Lambda role's inline policy gets one statement from each queue that the function consumes. Each `queue.consume` call adds its statement to the policy, and none of them owns the whole document.

A param is collected when its schema item has `collect`. `collect` receives the values and combines them into the param. The inline policy joins the statements:

```ts [packages/aws.iac/src/resources/lambda/lambda-role-policy.ts]
PolicyDocument: {
  propertyType: "param",
  presence: "required",
  collect: (items) => ({
    Version: "2012-10-17",
    Statement: items.flatMap((item) => item.Statement ?? []),
  }),
},
```

While infra is being evaluated, any code can add to a collected param with `contribute`. `queue.consume` does this:

```ts [packages/aws/src/sqs/queue.ts]
consume(handler: SqsHandler | LambdaGroup, options: ConsumeOptions = {}) {
  const lambdaGroup = handler as LambdaGroup;
  const id = `${this.id}-${lambdaGroup.fn.id}-mapping`;

  lambdaGroup.policy.contribute(
    { PolicyDocument: { Statement: [this.grant(["ReceiveMessage", "DeleteMessage", "GetQueueAttributes"])] } },
    { by: id },
  );
  // ...
}
```

The rules for `collect`:

- `contribute` accepts only collected params, and a collected param is optional in config.
- `collect` receives the value from config first, if there is one, and then every contribution sorted by content. So moving a `contribute` call to another file never changes the result.
- When there is no value in config and no contribution, `collect` is not called and the param is left unset.

`mergeContributions` is a `collect` rule for maps. It merges the maps key by key, and fails when two contributions set one key to different values. The error names both contributors:

| Contributor called with                         | Named in the error as                    |
| ----------------------------------------------- | ---------------------------------------- |
| `{ by: "orders-orders-processOrders-mapping" }` | `orders-orders-processOrders-mapping`    |
| no `by`                                         | the `file:line` of the `contribute` call |

Library code that contributes for the user, such as `consume`, passes `by`, so the error names something the user wrote rather than a line inside the library. A value that holds a token is not known at plan, so plan cannot find a conflict with it, and deploy fails instead.

### Function contributions

A plain contribution cannot compute with an output value, because the output does not exist while infra is being evaluated. For example, to let a function send to every queue whose name starts with `orders-`, a policy statement needs the queue's ARN with `-*` appended. A function contribution receives the real output at deploy:

```ts [infra/orders.ts]
import { lambda } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";

const orderQueue = queue({ name: "orders" });
const importer = lambda({
  id: "order-importer",
  handler: "handler",
  code: { type: "file", path: "external/importer.mjs" },
});

importer.policy.contribute(
  ({ deps }) => ({
    PolicyDocument: {
      Statement: [
        {
          Effect: "Allow",
          Action: "sqs:SendMessage",
          Resource: `${deps.queue.output.QueueArn}-*`, // ← a real string at deploy
        },
      ],
    },
  }),
  { deps: { queue: orderQueue.queue } },
);
```

`contribute` takes the function and, in `deps`, the resources the function reads. `deps` is typed from those resources, so `deps.queue.output` is the queue's output type.

1. **While infra is evaluated**, `contribute` records the function and its deps. The policy now depends on the queue, and state records the edge.
2. **At deploy**, the queue deploys first. Deploy then runs the function with the queue's real output, and collects the result like a plain contribution. The `by` option, the call site, lifetime and conflicts work the same way. The result can only set collected params.
3. **At plan**, the function receives the same views of its deps as `deriveParams` (see [Unknown values](reconciler.md#unknown-values)). When the queue has no output yet, reading `deps.queue.output` throws, and plan marks every collected param of the policy unknown. When the queue exists, plan uses the function's result.

As an aside, a provider that stores a collected map as one string should still keep the map structured in the param, so state, diff and plan see each key. The provider encodes it only in `create` and `update`, for example with `sortedJson` from `@notation/utils`, and decodes it in `read`. A Lambda's [`Environment.Runtime`](../resources/lambda.md#environment) works this way.

### Lifetime

Contributions close when evaluation ends, and `contribute` and `dependOn` throw from then on. This keeps the params that plan and deploy read the same as the params that the infra code built. A resource made outside `collectResourceGraph` closes once code reads its params or dependencies.

`onEvaluationEnd(callback)` registers a callback that runs after evaluation and before the close, for generated code whose values do not exist while modules are still being evaluated. It is an engine mechanism, not user-facing API.

When you delete a `contribute` call, the collected value changes, and the resource updates on the next deploy. When the API cannot unset a removed field, the provider resets it to the API's default. When there is no default, mark the field `immutable`, so that removing it replaces the resource.

## Resource groups

A `ResourceGroup` bundles the low-level resources that make up a single logical construct. A Lambda group, for example, contains a Lambda function, an IAM role, a CloudWatch log group, and a zip package.

```ts
abstract class ResourceGroup<
  C extends Record<string, any> = Record<string, any>,
> {
  readonly type: string;
  readonly id: string;
  readonly config: C;
  readonly resources: BaseResource[];

  add<T extends BaseResource>(resource: T): T;
  addOnce<T>(
    ResourceClass: T,
    id: string,
    opts?: ResourceOpts,
  ): InstanceType<T>;
}
```

A group's constructor takes `(type, id, config?)`:

- `type` – the kind of group, such as `"Lambda"`.
- `id` – identifies the group across deployments. It must be unique among groups of the same type: declaring two groups with the same type and ID in one graph throws.
- `config` – the group's configuration, stored as `group.config`. Defaults to `{}`.

Each group derives its ID from a value the user supplies, the same value its resource IDs are built from, so the group's identity changes exactly when its resources' identities do:

| Group           | ID                         | Example               |
| --------------- | -------------------------- | --------------------- |
| `LambdaGroup`   | the lambda's `id`          | `get-todos`           |
| `ApiGroup`      | the API's `name`           | `todo-api`            |
| `RouteGroup`    | `<api id>-<method>-<path>` | `todo-api-GET-/todos` |
| `ScheduleGroup` | the schedule's `name`      | `nightly`             |
| `QueueGroup`    | the queue's `name`         | `orders`              |

`add()` records the group on the resource as `resource.group`, a `{ type, id }` pair. A resource that is in no group has `group: null`. The reconciler persists the pair with each resource's state.

Groups don't declare dependencies. Edges between groups follow from the dependencies of the resources they contain, since each resource records its group.

`addOnce` adds a resource unless the group already has one with the same ID, and returns the one the group holds. Use it for resources that bind two others, such as an API integration, which several call sites may create. It throws if the existing resource has a different class.

During graph construction, the group and each resource added via `add()` become part of the active graph automatically. This is how a construct like `export const getTodos = lambda({ ... })` maps to the 4–6 actual AWS resources required to run it.

Resource groups are collected during graph construction and used by the reconciler to determine the full set of resources to deploy or destroy.
