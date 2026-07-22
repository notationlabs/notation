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
      defaultValue: "index.handler",
    },
    MemorySize: {
      propertyType: "param",
      valueType: z.number(),
      presence: "optional",
      defaultValue: 128,
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

// derived – calculated from dependencies at deploy time via deriveParams()
IntegrationUri: { propertyType: "derived", valueType: z.string(), presence: "required" }
```

### Common fields

All schema items carry these fields:

| Field          | Type                                 | Description                                                      |
| -------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `propertyType` | `"param" \| "computed" \| "derived"` | Role of the field.                                               |
| `valueType`    | `ZodType`                            | Zod validator for type checking and serialisation.               |
| `presence`     | `"required" \| "optional"`           | Whether the field must be provided.                              |
| `sensitive`    | `true?`                              | Redacted in logs.                                                |
| `hidden`       | `true?`                              | Excluded from CLI display and state output.                      |
| `volatile`     | `true?`                              | Expected to change between reads; excluded from diff comparison. |

### Flags by property type

**`param`**

- `immutable` – cannot change after creation (forces replacement).
- `defaultValue` – fallback when no value is provided.
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
  callbackContext?: Readonly<Record<string, unknown>>;
  cause?: unknown;
});
```

| Handler result | Meaning | What the reconciler does |
| -------------- | ------- | ------------------------ |
| Return normally | The operation finished. | Continues the deployment. |
| `throw new ResourceNotFoundError(message, { cause })` | `read` found no resource for the given key. | Treats the resource as absent during planning and refresh. A read after create or update fails because that operation claimed to have finished. |
| `throw new ResourceOperationPendingError(message, { retryAfterMs, callbackContext })` | The operation has not finished. | Waits for `retryAfterMs`, then calls the same handler again. It passes `callbackContext` as the handler's final argument. |
| Throw any other error | The operation failed. | Stops the deployment. |

`ResourceNotFoundError` is for `read`. A `delete` handler must catch the provider's missing-resource error and return normally.

`ResourceOperationPendingError` may be thrown by `create`, `read`, `update`, or `delete`. Its options are:

| Option | Type | Required | Meaning |
| ------ | ---- | -------- | ------- |
| `retryAfterMs` | `number` | yes | Milliseconds to wait. It must be zero or greater. |
| `callbackContext` | `Readonly<Record<string, unknown>>` | no | Plain serializable data for the next attempt. |
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

Dependencies also determine deployment order: a resource is not created until all its dependencies exist.

## Resource groups

A `ResourceGroup` bundles the low-level resources that make up a single logical construct. A Lambda group, for example, contains a Lambda function, an IAM role, a CloudWatch log group, and a zip package.

```ts
abstract class ResourceGroup {
  type: string;
  id: number;
  dependencies: Record<string, number>;
  config: Record<string, any>;
  resources: BaseResource[];

  add<T extends BaseResource>(resource: T): T;
  findResource<T>(ResourceClass: T): InstanceType<T> | undefined;
}
```

Construction accepts `ResourceGroupOptions` with:

- `id` – an optional pre-assigned ID used outside graph collection.
- `dependencies` – map of dependency names to group IDs.

During graph construction, the group and each resource added via `add()` become part of the active graph automatically. This is how a construct like `export const getTodos = lambda({ ... })` maps to the 4–6 actual AWS resources required to run it.

Resource groups are collected during graph construction and used by the reconciler to determine the full set of resources to deploy or destroy.
