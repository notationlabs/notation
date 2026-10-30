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

**`computed`**

- `primaryKey` – identifies the resource (e.g. `FunctionArn` returned by `create`).

## Operations

`defineOperations` accepts CRUD handlers and parameter derivation:

| Field          | Required | Signature / Description                                                                                                                      |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`       | yes      | `(params, context?) => Promise<ComputedPrimaryKey<S>>` – create the resource, return its computed key.                                       |
| `read`         | no       | `(key, context?) => Promise<Result<S>>` – return the remote object or throw `ResourceNotFoundError`.                                         |
| `update`       | no       | `(key, patch, params, state, context?) => Promise<void>` – apply a partial update.                                                           |
| `delete`       | yes      | `(key, state, context?) => Promise<void>` – ensure the resource is absent. Implementations must also succeed when the remote resource is already gone. |
| `deriveParams` | no       | Computes intrinsic derived params from config (not dependency-aware).                                                                        |

The reconciler records params, results and state, so each must be a durable value: `null`, a boolean, number or string, `undefined`, an `Error`, or an array or plain object of these. From the result of `create` and `read`, the reconciler keeps only the properties the schema declares and turns each `Date` into an ISO 8601 string. Output and state types show these dates as strings. A `Buffer` or another class instance in a schema value type becomes `never`, so a handler that returns one does not compile. Return a file as its path and hash instead of its bytes.

### Operation errors

Import the errors from `@notation/resource`:

```ts
import {
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
```

| Handler result | Meaning | What the reconciler does |
| -------------- | ------- | ------------------------ |
| Return normally | The operation finished. | Continues the deployment. |
| `throw new ResourceNotFoundError(message, { cause })` | `read` or `delete` found no resource for the given key. | From `read`, treats the resource as absent during planning and drift detection; a read after create or update fails because that operation claimed to have finished. From `delete`, treats the delete as complete, since absence is its goal state. |
| `throw new ResourceOperationPendingError(message, { retryAfterMs, callbackContext })` | The operation has not finished. | Waits for `retryAfterMs`, then calls the same handler again. It passes `callbackContext` as the handler's final argument. |
| Throw any other error | The operation failed. | Stops the deployment. |

`ResourceNotFoundError` means the resource is absent wherever it is thrown. A `delete` handler may either catch the provider's missing-resource error and return normally, or translate it to `ResourceNotFoundError`; both count as success.

`ResourceOperationPendingError` may be thrown by `create`, `read`, `update`, or `delete`. Its options are:

| Option | Type | Required | Meaning |
| ------ | ---- | -------- | ------- |
| `retryAfterMs` | `number` | yes | Milliseconds to wait. It must be zero or greater. |
| `callbackContext` | `Readonly<DurableObject>` | no | Data for the next attempt. The reconciler records it with the error. If it holds a value that is not durable, such as a `Date`, the next attempt receives `undefined`. |
| `cause` | `unknown` | no | The provider error that caused this result. |

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

`requireDependencies` declares typed dependency slots. `deriveParams` receives `{ id, config, deps }` and returns properties computed from dependency outputs. The values are resolved at deploy time after dependencies have been provisioned.

A resource takes its ID first, then its config and dependencies:

```ts
const integration = new LambdaIntegration("todo-api-get-todos-integration", {
  dependencies: { api, lambda },
});
```

The ID keys the resource in state, so keep it stable. The second argument can be left out when neither `config` nor `dependencies` has a required property.

Dependencies also determine deployment order: a resource is not created until all its dependencies exist.

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

`add()` records the group on the resource as `resource.group`, a `{ type, id }` pair. A resource that is in no group has `group: null`. The reconciler persists the pair with each resource's state.

Groups don't declare dependencies. Edges between groups follow from the dependencies of the resources they contain, since each resource records its group.

`addOnce` adds a resource unless the group already has one with the same ID, and returns the one the group holds. Use it for resources that bind two others, such as an API integration, which several call sites may create. It throws if the existing resource has a different class.

During graph construction, the group and each resource added via `add()` become part of the active graph automatically. This is how a construct like `export const getTodos = lambda({ ... })` maps to the 4–6 actual AWS resources required to run it.

Resource groups are collected during graph construction and used by the reconciler to determine the full set of resources to deploy or destroy.
