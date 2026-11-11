# Resource

Every cloud resource is represented as a typed, schema-driven object.

Source: `@notation/resource`

## Defining a resource

A resource is defined using the `defineResource` builder. The full chain looks like this:

```ts
import { defineResource } from "@notation/resource";
import * as v from "valibot";

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
}>({ type: "aws/lambda/LambdaFunction", provider: "@notation/aws/resources" })
  .defineSchema({
    // params – input properties
    FunctionName: {
      propertyType: "param",
      value: v.string(),
      presence: "required",
      immutable: true,
    },
    Runtime: {
      propertyType: "param",
      value: v.string(),
      presence: "required",
    },
    Handler: {
      propertyType: "param",
      value: v.string(),
      presence: "required",
    },
    MemorySize: {
      propertyType: "param",
      value: v.number(),
      presence: "optional",
    },

    // computed – populated by the cloud provider after creation
    FunctionArn: {
      propertyType: "computed",
      value: v.string(),
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

| Field            | Purpose                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`           | a `platform/service/ResourceName` string (e.g. `aws/lambda/LambdaFunction`).                                                                                         |
| `provider`       | the package or package subpath that exports the class (e.g. `@notation/aws/resources`). State records it with the type. See [Provider packages](#provider-packages). |
| `blocksDeleteOf` | `ResourceType[]?`. The types that the provider refuses to delete while a resource of this type depends on them. Defaults to `[]`.                                    |

When deploy replaces a resource of a listed type, it first deletes each resource of this type that depends on it, and creates it again after the new resource. AWS, for example, does not delete an EventBridge bus that has rules, so `aws/eventBridge/rule` lists the bus type:

```ts
const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
  blocksDeleteOf: [EventBus.type],
});
```

List a type only when the provider refuses the delete. A dependent of a type that does not list the type stays in place, and deploy updates it when its params change. Write the type as a string literal when importing the class would make an import cycle. Nothing checks that a listed type exists, so a mistyped type is ignored. The resource class exposes the list as `blocksDeleteOf`, as it exposes `type`.

**2. `resource({ type, provider })`** – `type` defines

**3. `defineSchema()`** – maps each field to a schema item. See [Schema items](#schema-items) below.

**4. `defineOperations()`** – CRUD handlers and error-handling config. See [Operations](#operations) below.

### Provider packages

When a resource's type no longer appears in code, deploy and destroy load the class from the package or package subpath that `provider` names, to delete the resource. `@notation/core` resolves it with `require.resolve` from the project, and then imports it. The provider must meet these conditions, or the record is left in place with a `reconciler.provider.load-failed` warning:

- Its entry in `exports` must have a `require` or `default` condition. An entry with only an `import` condition can't be resolved.
- Its entry must export resource classes, or namespaces of them, such as `export * as lambda from "./lambda"`. The loader registers each resource class among the exports and among the values of each exported namespace, and ignores other values. It also ignores a class whose `provider` names another package, such as a class re-exported from another provider. Give the provider its own entry, such as a `/resources` subpath, so that loading it does not import the rest of the package.
- The project, or a package in the project's dependency tree, must depend on it.

A class defined in the project itself can name the project's package, if the project's `package.json` has `exports` that meet the first two conditions, as Node resolves a package's own name through its `exports`. Otherwise, pass the class to deploy and destroy in `registry`, so that they can delete its resources.

## Schema items

Every field in the schema is a `SchemaItem`. Each item has a `propertyType` that determines its role:

```ts
// param – input, set when defining the resource
FunctionName: { propertyType: "param", value: v.string(), presence: "required", immutable: true }

// computed – output, set by the cloud provider after creation
FunctionArn: { propertyType: "computed", value: v.string(), presence: "required", primaryKey: true }
```

### Common fields

All schema items carry these fields:

| Field          | Type                       | Description                                                       |
| -------------- | -------------------------- | ----------------------------------------------------------------- |
| `propertyType` | `"param" \| "computed"`    | Role of the field.                                                |
| `value`        | `StandardSchemaV1`         | Validator for the field's value. See [Value types](#value-types). |
| `presence`     | `"required" \| "optional"` | Whether the field must be provided.                               |
| `sensitive`    | `true?`                    | Redacted in logs.                                                 |
| `hidden`       | `true?`                    | Excluded from CLI display and state output.                       |
| `volatile`     | `true?`                    | Expected to change between reads; excluded from diff comparison.  |

### Flags by property type

**`param`**

- `immutable` – cannot change after creation (forces replacement).
- `rejectReplace` – a function `(previous, desired) => string`. When a change to the param would replace the resource, plan and deploy fail with the returned message. Use it for a param that the user can change by accident, on a resource whose delete loses data.
- `primaryKey` / `secondaryKey` – together form the compound key used for read/update/delete.
- `collect` – makes the param collected, and combines what is contributed to it. See [Contributions](#contributions).

**`computed`**

- `primaryKey` – identifies the resource (e.g. `FunctionArn` returned by `create`).

### Value types

Every schema item has a required `value`, which can be any [Standard Schema](https://standardschema.dev): a valibot, Zod, ArkType or Effect schema, for example. The engine calls only `~standard.validate`, so it depends on no validator library.

The validator's output type is the field's type. TypeScript checks it against the type the API schema gives the field, so a validator that does not match the API type does not compile:

```ts
MaxSessionDuration: { propertyType: "param", presence: "optional", value: v.string() }
//                    ^ error: string is not number
```

A field that needs a narrower type than the API's, such as one of a few strings, uses a narrower validator. Its output must still be assignable to the API's type.

The engine only checks values. It keeps the value it was given, not the validator's output. So the validator's input type must also be assignable to the field's type, and a validator that transforms its input, such as `v.pipe(v.string(), v.transform(Number))`, does not compile. A default that a validator fills in for an optional field, such as `v.optional(v.string(), "x")`, still compiles but is not applied.

The engine validates values at five points:

| Point       | What is validated                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration | The resource's config, in its constructor. The outputs that [output refs](#output-refs) point at are not known yet; see [Values that hold unknowns](#values-that-hold-unknowns). An async validator's result is awaited when `collectResourceGraph` ends. |
| Plan        | Every param the plan knows. Values that are unknown until apply are treated as described in [Values that hold unknowns](#values-that-hold-unknowns).                                                                                                      |
| Deploy      | Every param deploy knows, before it changes anything. Then each resource's full params, just before its own operation, which checks the values that come from other resources' outputs.                                                                   |
| Create      | Every field of a `create` result. The reconciler records the resource, then fails the deploy.                                                                                                                                                             |
| Read        | Every field of a `read` result. A malformed read fails the plan or deploy, so that it is never compared with params.                                                                                                                                      |

An invalid value raises `ValueValidationError`. Its message names the resource, the field and the `file:line` that declared the resource, and its `issues` list what the validator reported. For a `sensitive` field, each issue keeps its path but has a generic message, because a validator's message can include the value. The `file:line` is the first frame of the call stack outside node_modules and the @notation packages, so a resource that a library helper declares is reported at the user's code that called the helper. The CLI bundles infra code with source maps and turns on Node's source map support, so the `file:line` names the user's source file, not the bundle.

Destroy and `notation viz` collect the graph with `collectResourceGraph(evaluate, { declarationChecks: false })`, so that config which fails its checks does not block them.

The engine also checks the fields of values against the schema, and raises `SchemaStructureError` when:

- config or params hold a field that is not a param in the schema;
- `create` returns a field that the schema has but not as computed;
- params leave out a required param, at plan and deploy;
- a required computed field has no value after create or update.

The last two can only be found after the provider has made its change. So can an invalid value in a `create` result, and a malformed read after create or update. In each case the reconciler writes the resource's record first, so that state still tracks the resource, and then fails. When the read is malformed, the record holds the params and the outputs known without the read. When a later deploy finds no change for a resource whose record lacks a required output, it reads the resource again and writes the record with what the read returns. While the output is still missing, or when the resource has no `read`, every deploy fails, so that dependents never receive the output as undefined.

### Values that hold unknowns

At declaration, the outputs that output refs point at are not known yet. At plan, and before deploy changes anything, some values are unknown until apply. A field whose value is unknown as a whole is not validated. A field that holds unknowns, such as a policy document with one output ARN, is validated with the unknowns in place. The engine then drops each issue that the unknowns could cause:

- an issue whose path points at an unknown value, or inside one;
- an issue whose path points at a parent of an unknown value, such as a failed union or object check;
- an issue with no path, which is at the root of the field.

The other issues are reported. When the validator throws on a field that holds unknowns, the engine treats the field as valid. Just before the resource's own operation, every value is known, and the whole field is validated.

A check over a whole field reports its issue with no path. So when any part of the field is unknown, the check does not run at declaration or plan, only just before the operation. This applies to a union or `v.check` on the field itself, such as a check that a policy document has either `Action` or `NotAction`. Put such a check on the smallest object it applies to, such as each statement, so that it runs for the parts of the field that are known:

```ts
const statement = v.union([
  v.object({ Action: stringOrStrings, NotAction: v.optional(v.never()) }),
  v.object({ NotAction: stringOrStrings, Action: v.optional(v.never()) }),
]);
```

An issue in a statement that holds an unknown is still dropped, because the statement is a parent of the unknown.

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

The reconciler records params, results and state, so each must be a durable value as `@notation/durable` 0.9.0 defines it: `null`, a boolean, number, string or `bigint`, `undefined`, a `Date`, an `Error`, or an array, `Map`, `Set` or plain object of these. From the result of `create` and `read`, the reconciler keeps only the properties the schema declares. A `Buffer` or another class instance in a schema value type becomes `never`, so a handler that returns one does not compile. Return a file as its path and hash instead of its bytes.

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
  throttled?: boolean;
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
| `throttled`       | `boolean`                 | no       | Set to `true` when the provider refused the request because of a rate limit. A throttled `read` then doesn't report that the resource exists. The default is `false`.    |
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
2. A resource with `read`, whose key is made of params, is read by the key it would have. A read that throws `ResourceOperationPendingError` finds the resource, because a pending read means that the resource exists. A read that throws a throttled `ResourceOperationPendingError` doesn't.
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

In `@notation/aws/resources`, `awsCreate` wraps a `create` handler and throws `ResourceCreationUnknownError` when an AWS call times out, loses its connection or gets a server error.

## Dependencies

A resource can depend on other resources. After `defineOperations`, chain `requireDependencies` and `deriveParams`:

```ts
const LambdaIntegration = defineResource<{ ... }>({ type: "aws/apiGateway/LambdaIntegration" })
  .defineSchema({ ... })
  .defineOperations({ ... })
  .requireDependencies<{ api: ApiInstance; lambda: LambdaFunctionInstance }>()
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

## Output refs

An output, such as a queue's ARN, does not exist until the provider creates the resource. Infra code still needs to put it in another resource's config. `resource.outputRef(key)` returns an output ref. This is an object that names the resource and one of its outputs. It does not hold the output. TypeScript types it as the output, so it fits where the output would go:

```ts [packages/aws/src/sqs/queue.ts]
const queue = new aws.sqs.Queue("orders-queue", {
  config: { QueueName: "orders" },
});

const mapping = new aws.lambda.LambdaEventSourceMapping("orders-mapping", {
  config: { EventSourceArn: queue.outputRef("QueueArn") },
});
```

The ref has two effects:

- `mapping` depends on `queue`, so the queue deploys first.
- Deploy replaces the ref with the queue's real ARN before it calls the provider for `mapping`. A ref to a number becomes a number.

**A ref can only be placed whole.** Turning it into a string throws `OutputRefStringError`, whether in a template string, with `String()` or with `JSON.stringify`. This matters because a string such as `` `${arn}/*` `` would hide the ref, and plan could not tell that the value is unknown. It follows that a ref cannot be a map key: key the entry by something known now, and put the ref inside it. To compute with an output, use `deriveParams` or a [function contribution](#function-contributions), which receive the real output at deploy.

## Contributions

Some params take values from several places. For example, a Lambda role's inline policy gets one statement from each queue that the function reads. Each queue that is mapped to the function, with `sqs.bind(queue)` or `eventSourceMapping()`, adds its statement to the policy, and none of them owns the whole document.

A param is collected when its schema item has `collect`. `collect` receives the values and combines them into the param. The inline policy joins the statements:

```ts [packages/aws/src/resources/lambda/lambda-role-policy.ts]
PolicyDocument: {
  propertyType: "param",
  presence: "required",
  value: policyDocumentValue,
  collect: (items) => ({
    Version: "2012-10-17",
    Statement: items.flatMap((item) => item.Statement ?? []),
  }),
},
```

While infra is being evaluated, any code can add to a collected param with `contribute`. The queue's `~subscribe` method, which maps the queue to a Lambda group, does this:

```ts [packages/aws/src/sqs/queue.ts]
"~subscribe"(lambdaGroup: LambdaGroup, options: SqsOptions = {}): void {
  const id = `${this.id}-${lambdaGroup.fn.id}-mapping`;

  lambdaGroup.policy.contribute(
    { PolicyDocument: { Statement: [this.grant(["ReceiveMessage", "DeleteMessage", "GetQueueAttributes"])] } },
  );
  // ...
}
```

The rules for `collect`:

- `contribute` accepts only collected params, and a collected param is optional in config.
- `collect` receives the value from config first, if there is one, and then every contribution sorted by content. So moving a `contribute` call to another file never changes the result.
- When there is no value in config and no contribution, `collect` is not called and the param is left unset.

`mergeContributions` is a `collect` rule for maps. It merges the maps key by key, and fails when two contributions set one key to different values. The error names each contribution by the `file:line` of its `contribute` call, and gives the path of the key:

```
Conflicting contributions to orders: infra/orders.ts:12 and infra/refunds.ts:8 both set Environment.Variables.QUEUE_URL, to "a" and "b"
```

Library code that contributes a map entry for the user should key the entry by a name the user chose, such as a binding's ID. Two calls of the library code then never set the same key, and when the library conflicts with the user's code, the key path names the binding. A value that holds an output ref is not known at plan, so plan cannot find a conflict with it, and deploy fails instead.

### Function contributions

A plain contribution cannot compute with an output ref, because the output does not exist while infra is being evaluated. For example, to let a function send to every queue whose name starts with `orders-`, a policy statement needs the queue's ARN with `-*` appended. A function contribution receives the real output at deploy:

```ts [infra/orders.ts]
import { lambda } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

const orderQueue = queue({ id: "orders", schema: Order });
const importer = lambda({
  id: "order-importer",
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
2. **At deploy**, the queue deploys first. Deploy then runs the function with the queue's real output, and collects the result like a plain contribution. The call site, lifetime and conflicts work the same way. The result can only set collected params.
3. **At plan**, the function receives the same views of its deps as `deriveParams` (see [Unknown values](reconciler.md#unknown-values)). When the queue has no output yet, reading `deps.queue.output` throws, and plan marks every collected param of the policy unknown. When the queue exists, plan uses the function's result.

As an aside, a provider that stores a collected map as one string should still keep the map structured in the param, so state, diff and plan see each key. The provider encodes it only in `create` and `update`, for example with `sortedJson` from `@notation/utils`, and decodes it in `read`.

### Lifetime

Contributions close when evaluation ends, and `contribute` and `dependOn` throw from then on. This keeps the params that plan and deploy read the same as the params that the infra code built. A resource made outside `collectResourceGraph` closes once code reads its params or dependencies.

`onEvaluationEnd(callback)` registers a callback that runs after evaluation and before the close, for code whose values do not exist while modules are still being evaluated. It throws when no resource graph is being collected. In `@notation/aws`, `$lambda` uses it to build a Lambda's resources and the resources that its event makes: the mapping of `sqs.bind(queue)`, the route of `apiGateway.bind(api).defineRoute()`, and the rules of `eventBridge.bind(bus).defineRule()` and `eventBridge.defineSchedule()`. `eventSourceMapping()`, `route()`, `rule()` and `schedule()` use it to wire a declaration. A runtime module and the infra module that wires it often import each other, so a declaration can be read safely only after every module has loaded. It is an engine mechanism, not user-facing API.

`perCollection(key, create)` returns a function that gives one value for each resource graph that is being collected. The first call in a graph makes the value with `create`. The function returns `undefined` when no graph is being collected. A provider package keeps its declarations in such a store, so that two graphs collected in one process don't see each other's declarations. `@notation/resource` is loaded once, so two installed copies of a provider package that pass the same `key` share the value. `@notation/aws` keeps its claimed AWS names and the default event bus this way, and `@notation/cloudflare` keeps its Workers, their names and the namespace ids.

### Declared modules

The infra build wraps each declaration, such as a `$lambda` call, in a call that records the declaration's module. `declaredIn(value, path, binding, moduleExports?)` records the module's path, relative to the project root, and the local name of the binding on `value`, under `Symbol.for("@notation/declaredIn")`, and returns `value`. For a declaration marked `platform: workerd`, `moduleExports` is `{ exports, starExports }`: the names that the runtime bundle re-exports besides the entry, and the specifiers of the module's `export * from` statements, whose names the bundle doesn't re-export. `getDeclaredIn(value)` returns the record, or `undefined`. `$lambda` reads the record to find the module, and so the path of the function's bundle.

When you delete a `contribute` call, the collected value changes, and the resource updates on the next deploy. When the API cannot unset a removed field, the provider resets it to the API's default. When there is no default, mark the field `immutable`, so that removing it replaces the resource.

### Cycles

A resource in `config` or `dependencies` must already be constructed, so two resources can only depend on each other through `contribute` or `dependOn`. For example, two Workers that call each other each contribute a service binding to the other:

```ts
const a = new WorkerScript("a", { config: { ScriptName: "a" } });
const b = new WorkerScript("b", { config: { ScriptName: "b" } });
a.contribute({
  Bindings: [
    { type: "service", name: "B", service: b.outputValue("ScriptName") },
  ],
});
b.contribute({
  Bindings: [
    { type: "service", name: "A", service: a.outputValue("ScriptName") },
  ],
});
```

Deploy breaks the cycle at a placeholder. It creates the placeholder first, with its params without any contribution. It creates the other members, and then updates the placeholder with its full params:

```
create a (no bindings) → create b (binds a) → update a (binds b)
```

A member can be the placeholder when:

- it depends on the other members of the loop only through its contributions, not through its config, its `dependencies` or `dependOn`,
- each param that its contributions set is optional, and is not `immutable`, `primaryKey` or `secondaryKey`. A function contribution can set any collected param, so then this applies to every collected param,
- its type has `update`.

In each loop, the first member in the order of the resources that can be the placeholder becomes one. When no member of a loop can, plan and deploy fail with `ResourceCycleError`, which names the members of the loop and says why each of them can't be the placeholder.

Three methods give the engine what it needs: `getFixedDependencies()` returns the dependencies that don't come from contributions, `getContributedParams()` returns the collected params that contributions set, and `getParams({ contributions: false })` returns the params without any contribution. See [Dependency cycles](../internals/reconciler.md#dependency-cycles) for how deploy, destroy and plan handle a cycle.

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

Each declared resource takes an `id` from the user. The group's ID is that `id`, and its resource IDs are built from it, so the group's identity changes exactly when its resources' identities do. A group that links two others builds its ID from their IDs. A group that belongs to an API, such as a route or an authorizer, builds its ID from the API's `id` and its own. No group ID depends on a setting or on an AWS name, so changing a setting such as an authorizer's issuer, or the `name` that overrides an AWS name, keeps every ID:

| Group                | ID                                   | Example                             |
| -------------------- | ------------------------------------ | ----------------------------------- |
| `LambdaGroup`        | the lambda's `id`                    | `todos`                             |
| `ApiGroup`           | the API's `id`                       | `todo-api`                          |
| `JwtAuthorizerGroup` | `api-authorizer:<api id>:<id>`       | `api-authorizer:todo-api:user-auth` |
| `RouteGroup`         | `api-route:<api id>:<method> <path>` | `api-route:todo-api:GET /todos`     |
| `ScheduleGroup`      | the schedule's `id`                  | `nightly`                           |
| `QueueGroup`         | the queue's `id`                     | `orders`                            |

A resource ID is a type prefix and the IDs that the resource belongs to, joined with `:`, as `resourceId()` in `@notation/aws` builds it. For example, a Lambda's role is `lambda:<lambda id>:role`, and a queue is `sqs-queue:<queue id>`. An `id` can't contain `:`, so two resources get the same ID only when they have the same type and the same IDs. Only the last part may contain `:`, such as the path in a route's ID. The mapping from a queue to a Lambda is a resource in the `QueueGroup`, with the ID `sqs-mapping:<queue id>:<lambda id>`. API integrations and permissions are resources in the `LambdaGroup`, with IDs such as `api-integration:<api id>:<lambda id>`.

`add()` records the group on the resource as `resource.group`, a `{ type, id }` pair. A resource that is in no group has `group: null`. The reconciler persists the pair with each resource's state.

Groups don't declare dependencies. Edges between groups follow from the dependencies of the resources they contain, since each resource records its group.

`addOnce` adds a resource unless the group already has one with the same ID, and returns the one the group holds. Use it for resources that bind two others, such as an API integration, which several call sites may create. It throws if the existing resource has a different class.

During graph construction, the group and each resource added via `add()` become part of the active graph automatically. This is how a construct like `export const external = lambda({ ... })` maps to the 4–6 actual AWS resources required to run it.

Resource groups are collected during graph construction and used by the reconciler to determine the full set of resources to deploy or destroy.
