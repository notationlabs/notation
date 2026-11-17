# Resource

Every cloud resource is represented as a typed, schema-driven object.

Source: `@notation/resource`

Resources come in two kinds. Each kind has its own builder and base class:

| Kind     | `kind`                | Builder                      | Credentials  | Operations                                                                           |
| -------- | --------------------- | ---------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| Resource | `"resource"`          | `resource()`                 | any number   | `create`, `delete`; optional `read`, `update`, `find`, and `rotate` for a credential |
| Source   | `"credential-source"` | `credentialSourceResource()` | one, `value` | `read`, `loadCredential`                                                             |

A resource is something that deploy creates at a provider. A source supplies a value that exists outside Notation, such as an environment variable. Most of this page is about resources. See [Credential sources](#credential-sources) for sources.

The reconciler reads the kind from the `kind` field of `BaseResource`, which each base class sets. It does not use `instanceof`, which fails when two copies of `@notation/resource` are loaded. `isCredentialSource(resource)` checks the field.

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

| Field                   | Purpose                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                  | a `platform/service/ResourceName` string (e.g. `aws/lambda/LambdaFunction`).                                                                                         |
| `provider`              | the package or package subpath that exports the class (e.g. `@notation/aws/resources`). State records it with the type. See [Provider packages](#provider-packages). |
| `blocksDeleteOf`        | `ResourceType[]?`. The types that the provider refuses to delete while a resource of this type depends on them. Defaults to `[]`.                                    |
| `deleteTakesDependents` | `boolean?`. Set when `delete` uses its `deletion` argument. See [Deletes of a resource that others refer to](#deletes-of-a-resource-that-others-refer-to).           |
| `replaceCreatesFirst`   | `boolean?`. Set when every replace changes the resource's key, so the replacement can exist beside the old resource. Deploy then replaces the type create-first.     |
| `readLagsCreate`        | `boolean?`. Set when the provider can report a new resource as not found for a while after `create` returns. Deploy then retries a not-found read after a create.    |

When deploy replaces a resource of a listed type delete-first, it first deletes each resource of this type that depends on it, and creates it again after the new resource. A type with a `physicalName` param, or with `replaceCreatesFirst`, is replaced create-first, and then no dependent is deleted in advance. See [Create-first replacement](../internals/reconciler.md#create-first-replacement). AWS, for example, does not delete an EventBridge bus that has rules, so `aws/eventBridge/rule` lists the bus type. A bus has a generated name and is replaced create-first, so no class in Notation's provider packages uses the list today:

```ts
const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
  blocksDeleteOf: [EventBus.type],
});
```

List a type only when the provider refuses the delete. A dependent of a type that does not list the type stays in place, and deploy updates it when its params change. Write the type as a string literal when importing the class would make an import cycle. Nothing checks that a listed type exists, so a mistyped type is ignored. The resource class exposes the list as `blocksDeleteOf`, as it exposes `type`.

#### Deletes of a resource that others refer to

Some providers refuse to delete a resource while another resource refers to it, and can force the delete. Cloudflare does this for a Worker that another Worker binds. Deploy must delete such a resource while a dependent still refers to it in three cases: when it replaces the resource, when resources that depend on each other are destroyed, and when they are removed from code.

Set `deleteTakesDependents` on the type. `delete` then gets `deletion.dependents`: the resources whose state records depend on the deleted resource, each with its `id`, `type` and the `params` in its record. Deploy updates or deletes each of them in the same run. For the delete of a retired instance, which a create-first replace left, the list leaves out the resources in code, as deploy has updated them to use the replacement. It lists the retired instances of other resources that depend on the instance, each with the ID of its record and its own params. Force the delete only when every reference to the resource comes from one of the dependents, and fail otherwise, as nothing repairs a reference from a resource that the deployment does not manage:

```ts
const workerScript = resource<WorkerScriptSchema>({
  type: "cloudflare/workers/WorkerScript",
  provider: "@notation/cloudflare/resources",
  deleteTakesDependents: true,
});
```

Deploy lists state before each delete of a resource of such a type, so set it only when `delete` uses the argument. Without it, `deletion` is undefined. A forced delete can leave the dependents' references broken until deploy updates them. Deploy updates a dependent only when its params change, so a replacement must change an output that the dependents take, such as the name.

**2. `resource({ type, provider })`** – `type` defines

**3. `defineSchema()`** – maps each field to a schema item. See [Schema items](#schema-items) below.

**4. `defineOperations()`** – CRUD handlers and error-handling config. See [Operations](#operations) below.

### Provider packages

When a resource's type no longer appears in code, deploy and destroy load the class from the package or package subpath that `provider` names, to delete the resource. A source needs no class to be deleted, so its package is not loaded. `@notation/core` resolves it with `require.resolve` from the project, and then imports it. The provider must meet these conditions, or the record is left in place with a `reconciler.provider.load-failed` warning:

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

// credential – a secret that the provider returns from create, and that is never recorded
PrivateKey: { propertyType: "credential", value: v.string() }
```

### Common fields

All schema items carry these fields:

| Field          | Type                                    | Description                                                       |
| -------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `propertyType` | `"param" \| "computed" \| "credential"` | Role of the field.                                                |
| `value`        | `StandardSchemaV1`                      | Validator for the field's value. See [Value types](#value-types). |
| `presence`     | `"required" \| "optional"`              | Whether the field must be provided. A `credential` has none.      |
| `sensitive`    | `true?`                                 | Redacted in logs.                                                 |
| `hidden`       | `true?`                                 | Excluded from CLI display and state output.                       |
| `volatile`     | `true?`                                 | Expected to change between reads; excluded from diff comparison.  |

### Flags by property type

**`param`**

- `immutable` – cannot change after creation (forces replacement).
- `rejectReplace` – a function `(previous, desired) => string`. When a change to the param would replace the resource, plan and deploy fail with the returned message. Use it for a param that the user can change by accident, on a resource whose delete loses data.
- `primaryKey` / `secondaryKey` – together form the compound key used for read/update/delete.
- `collect` – makes the param collected, and combines what is contributed to it. See [Contributions](#contributions).
- `physicalName` – marks the param as the resource's physical name, with the rule of the provider's names. Deploy always generates the name, and config cannot set it. See [Physical names](#physical-names).

**`computed`**

- `primaryKey` – identifies the resource (e.g. `FunctionArn` returned by `create`).

**`credential`**

A credential has no flags. See [Credentials](#credentials).

### Physical names

A resource's physical name is its name in the provider, such as a queue's `QueueName`. Mark the param that holds it with `physicalName`, and give it the rule of the provider's names:

```ts
QueueName: {
  propertyType: "param",
  presence: "required",
  immutable: true,
  value: v.string(),
  physicalName: {
    maxLength: 80,
    ending: (params) => (params.FifoQueue === true ? ".fifo" : ""),
    // "sqs-queue:orders" gives "orders"
    base: (resourceId) => resourceId.slice(resourceId.indexOf(":") + 1),
  },
},
```

The rule is a `PhysicalNameRule` from `@notation/resource`:

| Field       | Required | Meaning                                                                                                                                                                                                 |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxLength` | yes      | The longest name the provider accepts.                                                                                                                                                                  |
| `ending`    | no       | A function that takes the resource's params and returns the ending that the provider requires on the name, such as `.fifo`, or `""` for none. Without it, a generated name has no ending.               |
| `base`      | no       | A function that takes the resource ID and returns the base of a generated name. Use it to leave a part of the ID out of the name, such as a type prefix. Without it, the base is the whole resource ID. |

**The reconciler owns the physical name.** A resource class declares all of the provider's fields, including the name field, such as `FunctionName`, `RoleName` or `QueueName`. The reconciler generates the value of the name field from the resource ID. Config cannot set it: the config type leaves the param out, also when its `presence` is `required`. The params, the state record and the outputs still hold it.

```ts
new aws.sqs.Queue("sqs-queue:orders", { config: { FifoQueue: true } });
// deploy names the queue my-app--prod--orders-1a2b3c4d.fifo
```

There is no way to set an exact name for now. If a resource needs one later, an override will be added then.

Deploy generates the name, `<app>--<stage>--<base>-<instance>`, from the app, the stage, the base and 8 random hex characters. The base is the result of the rule's `base`, or the resource ID, in lower case, with each run of characters other than `a-z` and `0-9` turned into one `-`. Deploy keeps the name in the state record, so later deploys use the same name, and a replacement gets a new one. The params that an operation receives always hold the name. Plan shows the name as unknown until the resource exists. See [Generated names](../internals/reconciler.md#generated-names) for the steps and their limits.

**Nothing else supplies a `physicalName` param.** When `deriveParams` returns a value for the param, or untyped config holds one, plan and deploy throw. A generated or recorded name would replace the value.

**A dependent reads the name through an output ref.** `resource.config` does not hold the name, so another resource can't copy the name from it. It takes `role.outputRef("RoleName")` instead, which deploy fills in once the role exists; see [Output refs](#output-refs). At plan the ref is unknown until then.

**A resource can hold its own name in another param.** For example, a Worker that binds itself as a service contributes a binding that refers to its own `ScriptName`:

```ts
script.contribute({
  Bindings: [
    { type: "service", name: "SELF", service: script.outputRef("ScriptName") },
  ],
});
```

A ref from a resource to one of its own `physicalName` params is not a dependency, so the Worker is not a [cycle](#cycles) of one. Deploy fills in the ref when it fills in the name, before it calls `create`. So `create` receives the name as a plain string in both params, and the Worker is created once, with the binding. A replacement gets its new name in both params. Plan shows the ref as it shows the name: the recorded name, or unknown when there is no record or the resource is replaced. A ref to any other output of the resource itself is still a dependency.

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

The last two can only be found after the provider has made its change. So can an invalid value in a `create` result, and a malformed read after create or update. In each case the reconciler writes the resource's record first, so that state still tracks the resource, and then fails. When the read is malformed, the record holds the params and the outputs known without the read. When a later deploy finds no change for a resource whose record lacks a required output, it reads the resource again and writes the record with what the read returns. While the output is still missing, every deploy fails, so that dependents never receive the output as undefined. When the resource has no `read`, every deploy fails too, unless it replaces the resource, or deletes the resource before it replaces a dependency. In both cases the create writes the output. Deploy fails when it reaches the resource, before the resource's operation, so the resources before it have been deployed. Deploy can't fail before any change, because whether it replaces the resource depends on drift and on the new outputs of its dependencies. Plan fails before any change.

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

| Field            | Required | Signature / Description                                                                                                                                           |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`         | yes      | `(params, context?) => Promise<CreateResult<S>>` – create the resource, return its computed key and its [credentials](#credentials).                              |
| `rotate`         | no       | `{ [credential]: (key, state) => Promise<value> }` – issue a new value for a credential. See [Credentials](#credentials).                                         |
| `rotateManually` | no       | `{ [credential]: string }` – for a credential without `rotate`, how the user issues a new value at the provider. See [Credentials](#credentials).                 |
| `find`           | no       | `(params) => Promise<ComputedPrimaryKey<S>>` – find the resource that a create with `params` makes, and return its computed key. See [`find`](#find).             |
| `read`           | no       | `(key, context?) => Promise<Result<S>>` – return the remote object or throw `ResourceNotFoundError`.                                                              |
| `update`         | no       | `(key, patch, params, state, context?) => Promise<void>` – apply a partial update.                                                                                |
| `delete`         | yes      | `(key, state, context?, deletion?) => Promise<void>` – ensure the resource is absent. Implementations must also succeed when the remote resource is already gone. |
| `deriveParams`   | no       | Computes intrinsic derived params from config (not dependency-aware).                                                                                             |
| `rejectChange`   | no       | `(previous, desired, { replace }) => string \| undefined` – return a message to fail plan and deploy with. See [Rejecting a change](#rejecting-a-change).         |

The reconciler records params, results and state, so each must be a durable value as `@notation/durable` 0.9.0 defines it: `null`, a boolean, number, string or `bigint`, `undefined`, a `Date`, an `Error`, or an array, `Map`, `Set` or plain object of these. From the result of `create` and `read`, the reconciler keeps only the properties the schema declares. A `Buffer` or another class instance in a schema value type becomes `never`, so a handler that returns one does not compile. Return a file as its path and hash instead of its bytes.

### Rejecting a change

`rejectChange` checks a change to a resource that has a state record. `previous` is the params in state, as they were recorded: a record written before a param existed lacks that param, and state holds no `hidden` param. `desired` is the params in code, or `undefined` when deploy would delete the resource because it is no longer in code. `replace` is true when deploy deletes the resource and creates it again: a param that forces replacement changed, or a resource that it depends on is replaced and its type lists that resource's type in `blocksDeleteOf`. The function returns a message, and plan and deploy fail with it, before deploy changes any resource. It returns `undefined` to allow the change.

Plan calls it for each resource in code that has a state record, and for each orphan that the orphan sweep deletes: an orphan whose class is registered, and that no orphan with no registered class depends on, directly or through other orphans. Deploy calls it in the same cases before it takes the deployment hold, again for each resource with its real params before the resource's operation, for each dependent before a replacement deletes it, and for each orphan before the orphan sweep deletes it. Deploy's first check doesn't see a replacement that only a cascade causes, so for that case it fails when it reaches the replaced resource, before it deletes the dependents or the replaced resource. `notation destroy` doesn't call it. At plan, a param that comes from an output that doesn't exist yet is `UNKNOWN_AFTER_APPLY`. In deploy's first check, this holds only for a resource whose dependencies have no state record yet.

Use it for a change that would lose data and that a param's `rejectReplace` can't see, because it depends on more than one param, or because it is an update or a delete. The resource class and its instances expose it as `rejectChange`, as they expose `type`. `cloudflare/workers/WorkerScript` uses it to fail a change that would delete a Durable Object namespace, unless a param in state lists the namespace as unprotected. Consent read from `previous` holds for an orphan too, which has no `desired`, and consent must be deployed before the change that it allows.

### Operation errors

Import the errors from `@notation/resource`:

```ts
import {
  ResourceAlreadyExistsError,
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

new ResourceAlreadyExistsError(message: string, options?: { cause?: unknown });
```

| Handler result                                                                        | Meaning                                                                                   | What the reconciler does                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Return normally                                                                       | The operation finished.                                                                   | Continues the deployment.                                                                                                                                                                                                                                                                                                                                                            |
| `throw new ResourceNotFoundError(message, { cause })`                                 | `read` or `delete` found no resource for the given key.                                   | From `read`, treats the resource as absent during planning and drift detection; a read after create or update fails because that operation claimed to have finished. A read after create is retried instead when the class sets `readLagsCreate`: every 2 seconds, up to the operation attempt limit. From `delete`, treats the delete as complete, since absence is its goal state. |
| `throw new ResourceOperationPendingError(message, { retryAfterMs, callbackContext })` | The operation has not finished.                                                           | Waits for `retryAfterMs`, then calls the same handler again. It passes `callbackContext` as the handler's final argument.                                                                                                                                                                                                                                                            |
| `throw new ResourceCreationUnknownError(message, { cause })`                          | `create` cannot tell whether the provider made the resource, for example after a timeout. | Looks the resource up, as described in [Unknown create outcomes](#unknown-create-outcomes).                                                                                                                                                                                                                                                                                          |
| `throw new ResourceAlreadyExistsError(message, { cause })`                            | `create` was refused because a resource with the same key already exists.                 | Takes the existing resource over, as described in [Resources that already exist](#resources-that-already-exist).                                                                                                                                                                                                                                                                     |
| Throw any other error                                                                 | The operation failed.                                                                     | Stops the deployment.                                                                                                                                                                                                                                                                                                                                                                |

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

1. A resource with `find` is looked up with `find`.
2. A resource with `read`, whose key is made of params, is read by the key it would have. A read that throws `ResourceOperationPendingError` finds the resource, because a pending read means that the resource exists. A read that throws a throttled `ResourceOperationPendingError` doesn't.
3. Any other resource cannot be found. The reconciler calls `create` again after a stopped process, and fails the deployment on a `ResourceCreationUnknownError`.

When a lookup finds the resource, the reconciler takes it over, as described in [Resources that already exist](#resources-that-already-exist). When the lookup throws, the reconciler looks again after one second. When the outcome is still unknown after 10 attempts, or after `maxOperationAttempts` when it is lower, the deployment fails with a `WorkflowEffectError` with code `EFFECT_OUTCOME_UNKNOWN`.

A lookup must not report a resource as absent while a create for it can still finish. A provider whose reads are eventually consistent can break this rule.

In `@notation/aws/resources`, `awsCreate` wraps a `create` handler and throws `ResourceCreationUnknownError` when an AWS call times out, loses its connection or gets a server error. Its `alreadyExists` option takes a function that returns `true` for the provider's "already exists" error, which `awsCreate` then throws as `ResourceAlreadyExistsError`.

A `create` that makes more than one call should throw `ResourceCreationUnknownError` when a later call fails after an earlier call made the resource, so that the resource's `creating` record stays.

### Resources that already exist

A `create` handler throws `ResourceAlreadyExistsError` when the provider refuses the create because a resource with the same key exists, for example IAM's `EntityAlreadyExists`. The reconciler then takes the existing resource over, for every resource class: it reads the resource by its key, records it with the params that the read returned, and then updates, replaces or keeps it. The class must have a `read`. The create of a replacement does not do this for a resource that has the key of the replaced resource. It fails instead; see [Guard 1](../internals/reconciler.md#guard-1-a-replacement-does-not-take-over-a-resource-with-the-replaced-key).

```ts
create: awsCreate(
  async (params) => {
    await iam.send(new CreateRoleCommand(params));
  },
  { alreadyExists: (error) => error instanceof EntityAlreadyExistsException },
),
```

When the provider's create call overwrites or returns an existing resource instead of failing, as `PutRule` and `CreateQueue` do, `create` must check for the resource first and throw `ResourceAlreadyExistsError` itself.

**Start each resource's name with the app and the stage.** The reconciler does not check who made the existing resource. It takes over any resource with the same key, and then updates or replaces it to match config. This is only safe when no other deployment can use the key. A name that deploy generates for a `physicalName` param starts with `<app>--<stage>--`, so a resource with such a name belongs to the same app and stage. See [Physical names](#physical-names). A resource that lives inside another resource, such as a route in an API, needs no prefix when its parent's name has one.

See [Recoverable creates](../internals/reconciler.md#recoverable-creates) for the takeover steps and their limits.

### `find`

Define `find` when the provider assigns the resource's key, or part of it. The reconciler cannot compute such a key from params, so it calls `find(params)` to get it:

- before every `create`, to take over a resource that exists instead of making a second one
- to look up a create with an unknown outcome
- after `create` throws `ResourceAlreadyExistsError`
- to delete the resource of a `creating` record

`find` matches on an attribute that is unique, such as a name:

| Matches | `find` must                                                                                 |
| ------- | ------------------------------------------------------------------------------------------- |
| One     | Return what `create` would have returned: the computed key.                                 |
| None    | Throw `ResourceNotFoundError`.                                                              |
| Several | Throw another error that names the matches. The reconciler never takes over one of several. |

`find` should not match a resource that the provider reports as being deleted. The reconciler calls `find` before the create of a replacement too. In a delete-first replace, this is just after the delete. If `find` returns the deleted resource there, the replace fails.

The third row applies when the provider does not keep the attribute unique. API Gateway allows two APIs with the same name, so `Api`'s `find` reads every page of `GetApis` before it returns:

```ts
find: async (params) => {
  const apis = await listAllApis();
  const found = apis.filter((api) => api.Name === params.Name);
  if (found.length === 0) throw new ResourceNotFoundError("No API has the name");
  if (found.length > 1) {
    throw new Error(`Found ${found.length} APIs named ${params.Name}. Delete all but one.`);
  }
  return { ApiId: found[0].ApiId! };
},
```

A class with a key that the provider assigns and no `find` cannot be looked up. A create of it that stops before the reconciler records the key leaves a duplicate in the provider.

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

`requireDependencies` declares typed dependency slots. `deriveParams` receives `{ id, config, deps }` and returns properties computed from dependency outputs. At deploy it runs after its dependencies have been provisioned, with their real outputs. At plan, a dependency that has no output yet throws `PendingOutput` when `deriveParams` reads its `output`; see [Unknown values](../internals/reconciler.md#unknown-values).

`config`, and the `config` of each dependency, have their [output refs and derived values](#output-refs) filled in.

`deriveParams` receives stand-ins for its config and its dependencies, called views. See [Dependencies are views](#dependencies-are-views). A view reads like the object it stands for, with some values replaced:

- **A view of config** is a copy of the config in which each ref and derived value is replaced by its value. Where a value can't be read yet, the copy has a getter that throws.
- **A view of a dependency** is an object made with `Object.create(dep)`. Its prototype is the dependency, so it has the dependency's properties and methods. It replaces `config` with a view of the dependency's config. At plan it also replaces `output`, so that reading an output that isn't known yet throws `PendingOutput`.

So `deriveParams` reads config as plain values, as its type says:

- **At deploy**, every ref in config is known, and `deriveParams` receives the values.
- **At plan**, `deriveParams` receives a view of config. Reading a value that plan knows gives the value. Reading a ref or a derived value that plan doesn't know throws `PendingOutput`, as a read of a pending output in `deps` does. So does reading a credential that plan expects deploy to rotate. Plan then marks every param that config doesn't set as unknown.

Two values in config can't be read, at plan or at deploy, and reading one throws with the path of the param:

- a ref to the resource's own [physical name](#physical-names), because deploy decides the name after the params.
- a [credential](#credentials), because deploy puts its value in the params only for the call to an operation.

`deriveParams` can leave either in config without reading it, and deploy fills it in.

In the config of a dependency, only a credential throws. A ref to the dependency's own physical name reads as the name that the dependency was deployed with. At plan, it reads as the name in the dependency's state, and throws `PendingOutput` when the dependency has no state yet.

A `deriveParams` that annotates `deps` types it as `ResolvedDependencies<Deps>`, which types the `config` of each dependency as plain params.

A helper that `deriveParams` calls with one dependency, such as `deps.script`, types its argument as `ResolvedDependency<WorkerScriptInstance>`. It can't take `WorkerScriptInstance`, because the type of `deps.script` leaves out the private members of the instance.

```ts
const scriptName = (script: ResolvedDependency<WorkerScriptInstance>) =>
  script.output.ScriptName;
```

### Dependencies are views

Every entry of `deps` is a view, at plan and at deploy. So:

- `deps.queue === queue` is false.
- A `WeakMap` or a `Set` that holds the dependency doesn't find the view.
- A method of the dependency that reads a private field (`#field`) throws when it is called on the view. `outputRef`, `credentials` and `~state` run on the dependency, so they work.

A resource takes its ID first, then its config and dependencies:

```ts
const integration = new LambdaIntegration("todo-api-get-todos-integration", {
  dependencies: { api, lambda },
});
```

Infra code can construct a resource like this at the top level of a module. It is deployed with no group; see [Resource groups](#resource-groups).

The ID keys the resource in state, so keep it stable. The second argument can be left out when neither `config` nor `dependencies` has a required property.

Dependencies also determine deployment order: a resource is not created until all its dependencies exist.

`resource.dependOn(other)` adds a dependency after construction. It orders the deploy and is recorded in state, but `deriveParams` does not receive it. Like `contribute`, it throws once evaluation ends; see [Lifetime](#lifetime).

## Output refs

An output, such as a queue's ARN, does not exist until the provider creates the resource. Infra code still needs to put it in another resource's config. `resource.outputRef(key)` returns an output ref. This is an object that names the resource and one of its outputs. It does not hold the output. TypeScript types it as `OutputRef<T>`, where `T` is the type of the output, and a resource's config takes it where it takes a `T`:

```ts [packages/aws/src/sqs/queue.ts]
const queue = new aws.sqs.Queue("orders-queue", {
  config: { VisibilityTimeout: 60 },
});

const mapping = new aws.lambda.LambdaEventSourceMapping("orders-mapping", {
  config: { EventSourceArn: queue.outputRef("QueueArn") },
});
```

The ref has two effects:

- `mapping` depends on `queue`, so the queue deploys first.
- Deploy replaces the ref with the queue's real ARN before it calls the provider for `mapping`. A ref to a number becomes a number.

An output that the schema makes optional gives a ref to `T | undefined`. An optional param takes it, and a required param doesn't. Give it a default with `map`, which [Derived values](#derived-values) describes:

```ts
Name: bucket.outputRef("Alias").map((alias) => alias ?? "none"),
```

**A ref is not a string.** `OutputRef<string>` has no string methods, and a parameter typed `string` doesn't take it, so `new URL(queue.url)` fails the type check. A template literal and `+` accept any type, so `` `${arn}/*` `` passes the type check. At runtime, turning a ref into a string throws `OutputRefStringError`, whether in a template literal, with `String()` or with `JSON.stringify`:

```
Output orders-queue.QueueArn: an output ref can't be turned into a string. Place it whole, join it with text`…`, or compute with it in map().
```

The error matters because a string such as `` `${arn}/*` `` would hide the ref, and plan could not tell that the value is unknown. It follows that a ref cannot be a map key: key the entry by something known now, and put the ref inside it.

`Input<T>` from `@notation/resource` is the type of a value that config takes for a `T`: a `T`, an `OutputRef<T>` or a `Derived<T>`. A helper that passes a value on to config takes `Input<string>`:

```ts
function callbackFor(base: Input<string>) {
  return text`${base}/callback`;
}
```

`DeepInput<T>` is `Input` at each level of an object or an array. A resource's `config` and `contribute` take `DeepInput` of each param.

### Derived values

To compute with an output, make a derived value. A derived value holds the refs that it reads and a function of their values. Three functions make one, and each gives a `Derived<T>`:

| Made by       | Gives                                                          | Example                                                         |
| ------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `` text`…` `` | a string joined from strings, numbers, refs and derived values | `` text`${queue.arn}-*` ``                                      |
| `ref.map(fn)` | the result of `fn` on the value of a ref or a derived value    | `api.url.map((url) => new URL(url).host)`                       |
| `all([a, b])` | the list of the values of several refs and derived values      | `all([api.url, queue.arn]).map(([url, arn]) => ({ url, arn }))` |

A derived value goes where a ref goes: in config, in a contribution, in a Lambda's `env` or in a Worker's binding. The resource that holds it depends on the resource of each ref that it reads.

| Step           | A derived value                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration    | Validation skips a derived value that reads a ref. A derived value that reads no ref, such as `callbackFor("https://example.com")`, is computed, and the validator checks the result.                                         |
| Plan           | When every ref that it reads is known, plan runs the function and shows the result. Otherwise only the path of the derived value is unknown.                                                                                  |
| Deploy         | Deploy runs the function, and the param's validator checks the result.                                                                                                                                                        |
| Canonical form | `text` prints its parts, such as `<output orders-queue.QueueArn>-*`. `map` prints its ref and its call site, such as `<map of api.Url at infra/main.ts:17>`. The order of collected contributions follows the canonical form. |

The function of `map`:

- **is called with real values**, at plan when they are known, and at deploy. Plan and deploy can each call it more than once, so it must depend only on its argument.
- **returns a value that state can record.** A promise fails, and so does a value that holds, at any depth, a ref, a derived value, a function, or an object that is not a plain object or an array, such as a `URL`, a `Date` or a `Map`.
- **fails plan or deploy when it throws.** The error names the call site of `map`. In `ref.map(f).map(g)`, each `map` has its own call site.
- **is not async.**

Two `map` calls of the same ref at one call site have the same canonical form while the ref is unknown. This happens when your own helper calls `map`, such as `const suffix = (ref, s) => ref.map((url) => url + s)`: each call of `suffix` maps at the same line inside it. Plan can't tell the two values apart, so when they set one key to different values, plan finds no conflict, and deploy fails.

`text` checks each part when it joins them. A part must be a string or a number, so an optional output that is `undefined` at deploy fails, and doesn't become an empty string.

**A credential and a state ref can only be placed whole.** `map`, `text` and `all` reject a [credential](#credentials), because a value computed from it would be recorded in state as a plain param. They reject a [state ref](#state-refs) too. The types say so, and the functions throw for code that gets past the types.

`text` and `all` are marked `@resource`, so a function bundle that calls them fails to build, with the file and line of each call. A ref has no value in a function's code. A function reads a value through its declaration's `env`, or a Worker's `env`.

### Credentials

Some providers return a secret only in the response that creates a resource: the value of an API token, or the private key of a GitHub App. A `credential` property holds such a secret. `create` returns it with the computed key. A [source](#credential-sources) has a credential too, whose value it loads from outside Notation.

```ts
const githubAppSchema = githubApp.defineSchema({
  Name: { propertyType: "param", presence: "required", value: v.string() },
  AppId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  PrivateKey: { propertyType: "credential", value: v.string() },
});

export const GithubApp = githubAppSchema.defineOperations({
  create: async (params) => {
    const app = await createApp(params);
    return { AppId: app.id, PrivateKey: app.pem };
  },
  rotate: {
    PrivateKey: async (key) => createPrivateKey(key.AppId),
  },
  delete: async (key) => deleteApp(key.AppId),
});
```

Another resource takes the value with `resource.credentials.<name>`, which is an output ref typed `CredentialRef<T>`. A `CredentialRef<T>` doesn't fit an `OutputRef<T>`, and the other way round. Any param that isn't `hidden` takes one in place of its value:

```ts
new cloudflare.secretsStore.SecretsStoreSecret("app-key-secret", {
  config: { Value: app.credentials.PrivateKey },
  dependencies: { store },
});
```

The resource that takes the credential receives the value in two places:

- `create` receives every credential in its params.
- `update` receives the value of a credential, in its patch and in its params, only when the credential's version differs from the version in the resource's record. Every other credential is `undefined` in its place. The rule applies to each credential, not to each param: a param that holds several credentials, such as the `Secrets` of a Cloudflare Worker, receives only the values whose version changed.

The rule matters because deploy holds a value only in the process that received it. If a change anywhere in a param needed every value in it, an update would need values that an earlier deploy made, and a credential without `rotate` could not be issued again. So an `update` that sends the whole config to the provider has to leave an `undefined` credential out of the request. Otherwise it removes the value at the provider.

A drift update is the exception. When `read` shows that the provider lost a value, such as a Worker secret deleted outside Notation, the update receives the value of that credential. A `read` can return the credential markers of the params that it received, for the credentials that the provider still holds, and leave out the others.

The other operations never receive the value: `find` receives the marker in its params. The `state` that `update`, `delete` and `rotate` receive has no property for a credential of the resource itself, and `undefined` for a param that takes a credential. A value that `read` returns for a credential is dropped.

A `hidden` param cannot take a credential: state does not record a hidden param, so deploy could not tell which value the resource holds. Plan and deploy fail for it.

Deploy keeps the value in memory only:

- State, step results and events hold a marker in place of the value. The marker names the resource, the credential and a version.
- A string value is removed from error messages.
- `read` never returns a credential, and `resource.output` has no property for it.

A create, a rotate or [`--credential`](../cli/deploy.md#a-credential-that-you-rotate-by-hand) gives the credential a new version. The params of each resource that takes it then differ from its record, so deploy updates it with the new value. More than one resource can take the same credential.

Deploy holds a value only in the process that received it. It gets a new value when a resource that takes the credential needs one and deploy holds none:

1. A resource takes the credential and has no record, because it was added in a later deploy, or because an earlier deploy failed before it created the resource.
2. The record of a resource that takes the credential holds an older version, because an earlier deploy failed before it updated the resource.
3. A resource that takes the credential is created again: it is replaced, or drift detection found it gone.

To get a new value, deploy calls the credential's `rotate` operation, which returns a value and makes the provider revoke the one before. In cases 1 and 2 it rotates before it reaches the resources that take the credential. In case 3 it rotates when it reaches the resource, and then updates the resources before it that take the credential. Plan shows the rotation and the updates.

**Without `rotate`, the user rotates the credential by hand.** Plan fails, and deploy fails before it writes the resource that needs the value. Both print two commands: `notation deploy --credential`, which passes a value that the user issues at the provider, and `notation deploy --replace`, which replaces the resource that has the credential. See [A credential that you rotate by hand](../cli/deploy.md#a-credential-that-you-rotate-by-hand). Leave out `rotate` only when the provider has no API to issue another value.

For such a credential, give `rotateManually`: one sentence for each credential that tells the user how to issue a new value at the provider. The error prints it above the `--credential` command. Without it, the error prints ``Issue a new value of `<credential>` at the provider of `<type>`.``

```ts
export const App = appSchema.defineOperations({
  create: async (params) => {
    const app = await createApp(params);
    return { AppId: app.id, PrivateKey: app.pem };
  },
  rotateManually: {
    PrivateKey:
      "Generate a new private key in the GitHub App's settings, under Private keys.",
  },
  delete: async (key) => deleteApp(key.AppId),
});
```

The provider revokes the old value when deploy rotates, before any resource has the new one. If the deploy then fails before it updates a resource that takes the credential, that resource holds a revoked value until a later deploy succeeds. That deploy rotates again.

### State refs

An output ref always adds a dependency. Sometimes a resource needs an output of a resource that depends on it, and the dependency would make a cycle. For example, a Durable Object host lists the script names of the Workers that bind its namespace, so that it can move the namespace from them, and those Workers depend on the host.

`resource["~state"].outputRef(key)` returns a state ref. It is for the code of a resource package, like the other members that start with `~`:

```ts
host.contribute({
  DurableObjectTransferSources: [
    {
      namespaceId: "rooms",
      workerId: "web",
      scriptName: binder.script["~state"].outputRef("ScriptName"),
      nameBody: "shop--prod--web",
    },
  ],
});
```

A state ref differs from an output ref in five ways:

- **It adds no dependency.** `host` does not depend on `binder.script`, so the graph and the deploy order stay the same.
- **It resolves to the output in the target's state record at the start of the deploy.** Deploy reads these outputs once, after it takes the deployment hold, in the step `notation:recorded-outputs`. When this deploy replaces the target, the ref resolves to the output from before the replace. A resumed deploy uses the outputs that this step recorded. Plan reads the same outputs from state, so the value is known at plan.
- **It resolves to `undefined` when the target has no record**, or only a `creating` record. TypeScript types the ref as `StateRef<T>`, whose value is a `T` or `undefined`. A `StateRef` doesn't fit an `OutputRef`, so config doesn't take it.
- **It reads only an output that only a replace changes.** `outputRef(key)` throws unless the output is a param that is `immutable`, `primaryKey` or `secondaryKey`, or that has `physicalName`. An output that an update changes would be read one deploy late, with no error. It also throws for a `hidden` param, which the state record does not hold.
- **It can only be placed in a contribution, where the value can be `undefined`.** `create` and `update` read the refs in config from the live outputs of their targets, which a state ref's target may not have yet. `getDependencies()` throws when config holds a state ref. In a contribution, TypeScript takes a state ref only where `undefined` fits, such as an optional field. An item of an array is not such a place.

Make each state ref while infra is evaluated. Deploy reads the outputs of the resources that state refs name before it resolves any params, and a state ref made later fails at deploy.

### Deferred refs

A resource group can create its resources once every infra module has loaded, as a [Worker](../providers/cloudflare/workers.md#url) does. Its outputs are needed while the modules load, before the resources exist. `deferredOutputRef` from `@notation/resource` returns an output ref whose resource is found later. It is for the code of a resource package:

```ts
const url = deferredOutputRef<string>({
  resourceId: "worker:api:subdomain",
  path: ["Url"],
  resolve: () => group.subdomain,
});
```

It is an `OutputRef<T>`, and it goes wherever such a ref goes. It differs from a ref from `outputRef(key)` in two ways:

- **Its resource is found on the first read of `ref.resource`.** `resolve` is called once, and the ref keeps the resource. A read while the modules load throws, and names the ref. A read in an `onEvaluationEnd` callback calls `resolve`, which must then create the resource if it doesn't exist yet.
- **Its resource's id is given up front.** `ref.resourceId` holds it, for this ref and every other. An `OutputRefStringError` thrown while the modules load names the ref, and contributions sort by the [canonical form](#derived-values) without finding the resource.

The engine reads `ref.resource` only at plan and deploy: to find dependencies, to look up outputs, and to show values. Validation at declaration skips refs, and `text`, `map` and `all` hold the ref, so code that runs while the modules load can use a deferred ref as it uses any other. A deferred ref adds a dependency, as an output ref does.

## Credential sources

A source supplies a value that exists outside Notation, such as an environment variable or a secret in Infisical. Deploy creates nothing at a provider for a source, and never replaces one. `credentialSourceResource()` builds the class. A shortened `sources.Env` from `@notation/std/resources`, without `track`:

```ts [packages/std/src/resources/sources/env.ts]
import * as v from "valibot";
import { credentialSourceResource } from "@notation/resource";

export const Env = credentialSourceResource<{
  Params: { key: string };
  Value: string;
}>({
  type: "std/sources/Env",
  provider: "@notation/std/resources",
})
  .defineSchema({
    key: { propertyType: "param", presence: "required", value: v.string() },
    revision: {
      propertyType: "computed",
      presence: "required",
      value: v.string(),
    },
    value: { propertyType: "credential", value: v.string() },
  } as const)
  .defineOperations({
    read: async (params, context) => ({ revision: context.executionId }),
    loadCredential: async (state, context) => {
      const value = process.env[state.key];
      if (!value) throw new Error(`${state.key} is not set.`);
      return value;
    },
  });
```

The schema has params, a computed `revision`, any other computed outputs, and one credential, `value`. Another resource takes the value as `source.credentials.value`, as for any [credential](#credentials).

| Operation        | Called                                                                                           | Returns                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `read`           | by plan and deploy, for every source                                                             | the `revision`, and never the value. It may read the value to work the revision out.                           |
| `loadCredential` | by deploy, when a resource that takes the value is created or updated, and deploy holds no value | the value of `value` for the `revision` in `state`. It returns the same value each time for the same revision. |

**The credential's version is a SHA-256 of the source's ID, its params and its `revision`.** A change to a param or to the `revision` gives the credential a new version, so deploy updates every resource that takes it. A source with the same params and revision has the same version in every deploy, so loading the value again changes no other resource. Return a `revision` that changes whenever the value changes, such as a version that the secrets manager assigns. When the source has no such version, return `context.executionId`, so that the value is written on every deploy.

`read` receives a context:

| Field          | Description                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `id`           | The source's ID.                                                                                |
| `executionId`  | The ID of the deploy's execution, which a resumed deploy keeps. Each plan has an ID of its own. |
| `app`, `stage` | The app and the stage.                                                                          |
| `state`        | The outputs in the source's record, without its credential. Undefined when there is no record.  |
| `warn`         | `(message) => void`. Shows a warning for the source in the output of plan and deploy.           |

`loadCredential` receives `state` and the context without `state` and `warn`. `state` holds the params and the outputs that `read` returned in this deploy, without the credential.

- A source that no resource takes is never loaded.
- When a source leaves the code, deploy deletes its record and calls nothing. It does not load the source's provider package to do this.
- `--replace` and `--credential` refuse a source.
- Pass every value that `read` reads to `recordSecretValue` from `@notation/utils`, so that it is removed from error messages. The reconciler does this for the value that `loadCredential` returns.

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
- `contribute` takes the type of the items that `collect` declares. When `collect` declares no type, each contribution can leave out any field of an object, but not an item of an array. A rule that joins lists declares whole items, such as `(items: WorkerBinding[][]) => items.flat()`, so that each contributed item gives every required field.

`mergeContributions` is a `collect` rule for maps. It merges the maps key by key, and fails when two contributions set one key to different values. The error names each contribution by the `file:line` of its `contribute` call, and gives the path of the key:

```
Conflicting contributions to orders: infra/orders.ts:12 and infra/refunds.ts:8 both set Environment.Variables.QUEUE_URL, to "a" and "b"
```

Library code that contributes a map entry for the user should key the entry by a name the user chose, such as a binding's ID. Two calls of the library code then never set the same key, and when the library conflicts with the user's code, the key path names the binding. A value that holds an output ref is not known at plan, so plan cannot find a conflict with it, and deploy fails instead.

### Function contributions

**Function contributions are deprecated.** A later release removes them. Contribute values instead, with a [derived value](#derived-values) where the value is computed from an output. To let a function send to every queue whose name starts with `orders-`, a policy statement needs the queue's ARN with `-*` appended:

```ts [infra/orders.ts]
import { text } from "@notation/resource";
import { lambda } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

const orderQueue = queue({ id: "orders", schema: Order });
const importer = lambda({
  id: "order-importer",
  code: { type: "file", path: "external/importer.mjs" },
});

importer.policy.contribute({
  PolicyDocument: {
    Statement: [
      {
        Effect: "Allow",
        Action: "sqs:SendMessage",
        Resource: text`${orderQueue.arn}-*`, // ← a string at deploy
      },
    ],
  },
});
```

The same contribution as a function, which the type marks `@deprecated`:

```ts
importer.policy.contribute(
  ({ deps }) => ({
    PolicyDocument: {
      Statement: [
        {
          Effect: "Allow",
          Action: "sqs:SendMessage",
          Resource: `${deps.queue.output.QueueArn}-*`,
        },
      ],
    },
  }),
  { deps: { queue: orderQueue.queue } },
);
```

`contribute` takes the function and, in `deps`, the resources that the function reads. At deploy, deploy runs the function with the real outputs of `deps`, and with the config of each dependency filled in, as `deriveParams` receives it. It collects the result like a plain contribution. A function contribution has three costs that a contribution of values doesn't:

- **At plan**, the function receives the same views of its deps as `deriveParams` (see [Unknown values](../internals/reconciler.md#unknown-values)). When the queue has no output yet, reading `deps.queue.output` throws, and plan marks every collected param of the policy unknown. With `text`, only the path of `Resource` is unknown.
- **In a cycle**, a function contribution counts as setting every collected param. See [Cycles](#cycles).
- **It names the resource, not the output.** The function reads `orderQueue.queue`, the resource inside the group, where `orderQueue.arn` is the value it needs.

| A function contribution that             | Becomes                              |
| ---------------------------------------- | ------------------------------------ |
| places an output                         | the ref: `{ QUEUE_ARN: orders.arn }` |
| joins an output to a string              | `text`                               |
| computes with an output                  | `map`                                |
| computes with several outputs            | `all([...]).map(...)`                |
| chooses which keys to set from an output | `map` at the path above those keys   |

In the last row, the mapped value is unknown at its whole path while its ref is unknown. Plan then hides the keys that other contributions set under that path. At deploy the value is known, and it merges with the other contributions.

As an aside, a provider that stores a collected map as one string should still keep the map structured in the param, so state, diff and plan see each key. The provider encodes it only in `create` and `update`, for example with `sortedJson` from `@notation/utils`, and decodes it in `read`.

### Lifetime

Contributions close when evaluation ends, and `contribute` and `dependOn` throw from then on. This keeps the params that plan and deploy read the same as the params that the infra code built. A resource made outside `collectResourceGraph` closes once code reads its params or dependencies.

`onEvaluationEnd(callback)` registers a callback that runs after evaluation and before the close, for code whose values do not exist while modules are still being evaluated. It throws when no resource graph is being collected. In `@notation/aws`, `$lambda` uses it to build a Lambda's resources and the resources that its event makes: the mapping of `sqs.bind(queue)`, the route of `apiGateway.bind(api).defineRoute()`, and the rules of `eventBridge.bind(bus).defineRule()` and `eventBridge.defineSchedule()`. `eventSourceMapping()`, `route()`, `rule()` and `schedule()` use it to wire a declaration. A runtime module and the infra module that wires it often import each other, so a declaration can be read safely only after every module has loaded. It is an engine mechanism, not user-facing API.

`evaluationEnded()` returns `true` once the active collection has started to run its `onEvaluationEnd` callbacks, and `false` before that or when no resource graph is being collected. Code that must run while the modules load checks it. `addBindings()` in `@notation/cloudflare` uses it to fail a call from an `onEvaluationEnd` callback, as each Worker reads its bindings once the modules have loaded.

`perCollection(key, create)` returns a function that gives one value for each resource graph that is being collected. The first call in a graph makes the value with `create`. The function returns `undefined` when no graph is being collected. A provider package keeps its declarations in such a store, so that two graphs collected in one process don't see each other's declarations. `@notation/resource` is loaded once, so two installed copies of a provider package that pass the same `key` share the value. `@notation/aws` keeps its claimed AWS names and the default event bus this way, and `@notation/cloudflare` keeps its Workers and the namespace ids.

### Declared modules

The infra build wraps each declaration, such as a `$lambda` call, in a call that records the declaration's module. `declaredIn(value, path, binding, moduleExports?)` records the module's path, relative to the project root, and the local name of the binding on `value`, under `Symbol.for("@notation/declaredIn")`, and returns `value`. For a declaration marked `platform: workerd`, `moduleExports` is `{ exports, starExports }`: the names that the runtime bundle re-exports besides the entry, and the specifiers of the module's `export * from` statements, whose names the bundle doesn't re-export. `getDeclaredIn(value)` returns the record, or `undefined`. `$lambda` reads the record to find the module, and so the path of the function's bundle.

When you delete a `contribute` call, the collected value changes, and the resource updates on the next deploy. When the API cannot unset a removed field, the provider resets it to the API's default. When there is no default, mark the field `immutable`, so that removing it replaces the resource.

### Cycles

A resource in `config` or `dependencies` must already be constructed, so two resources can only depend on each other through `contribute` or `dependOn`. For example, two Workers that call each other each contribute a service binding to the other:

```ts
const a = new WorkerScript("worker:a", {
  config: configA,
  dependencies: depsA,
});
const b = new WorkerScript("worker:b", {
  config: configB,
  dependencies: depsB,
});
a.contribute({
  Bindings: [
    { type: "service", name: "B", service: b.outputRef("ScriptName") },
  ],
});
b.contribute({
  Bindings: [
    { type: "service", name: "A", service: a.outputRef("ScriptName") },
  ],
});
```

Both Workers are part of the deployment, though no group adds them; see [Resource groups](#resource-groups).

Deploy breaks the cycle at a placeholder. It creates the placeholder first, without the contributions that refer to the other members of the cycle. It creates the other members, and then updates the placeholder with its full params:

```
create a (no bindings) → create b (binds a) → update a (binds b)
```

A member can be the placeholder when:

- it depends on the other members of the loop only through its contributions, not through its config, its `dependencies` or `dependOn`,
- each param that its contributions that refer to other members set is optional, and is not `immutable`, `primaryKey` or `secondaryKey`. A function contribution can set any collected param, so then this applies to every collected param,
- its type has `update`.

Deploy leaves out a whole contribution when any value in it refers to another member. Use one contribution for each reference, so that the placeholder keeps the values that don't refer to other members. For example, contribute a service binding to another Worker on its own, not in the same `contribute` call as variables.

In each loop, the first member in the order of the resources that can be the placeholder becomes one. When no member of a loop can, plan and deploy fail with `ResourceCycleError`, which names the members of the loop and says why each of them can't be the placeholder.

Three methods give the engine what it needs: `getFixedDependencies()` returns the dependencies that don't come from contributions, `getContributedParams({ from })` returns the collected params that the contributions that depend on a resource in `from` set, and `getParams({ excludeContributionsFrom })` returns the params without the contributions that depend on a resource in `excludeContributionsFrom`. A contribution depends on the resources in the `deps` of a function contribution, or on the resources whose output refs it holds. A [state ref](#state-refs), and a ref to the resource's own `physicalName` param, add no dependency. See [Dependency cycles](../internals/reconciler.md#dependency-cycles) for how deploy, destroy and plan handle a cycle.

Destroy deletes the members of a cycle while they still refer to each other, and so does a replace of a member. When the provider refuses to delete a resource that another resource refers to, the type must force the delete. See [Deletes of a resource that others refer to](#deletes-of-a-resource-that-others-refer-to).

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
  readonly groups: ResourceGroup[];
  readonly parent: ResourceGroupRef | null;
  readonly ref: ResourceGroupRef;

  add<T extends BaseResource | ResourceGroup>(member: T): T;
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

Each declared resource takes an `id` from the user. The group's ID is that `id`, and its resource IDs are built from it, so the group's identity changes exactly when its resources' identities do. A group that links two others builds its ID from their IDs. A group that belongs to an API, such as a route or an authorizer, builds its ID from the API's `id` and its own. No group ID depends on a setting or on an AWS name, so changing a setting, such as an authorizer's issuer or its `name`, keeps every ID:

| Group                | ID                                   | Example                             |
| -------------------- | ------------------------------------ | ----------------------------------- |
| `LambdaGroup`        | the lambda's `id`                    | `todos`                             |
| `ApiGroup`           | the API's `id`                       | `todo-api`                          |
| `JwtAuthorizerGroup` | `api-authorizer:<api id>:<id>`       | `api-authorizer:todo-api:user-auth` |
| `RouteGroup`         | `api-route:<api id>:<method> <path>` | `api-route:todo-api:GET /todos`     |
| `ScheduleGroup`      | the schedule's `id`                  | `nightly`                           |
| `QueueGroup`         | the queue's `id`                     | `orders`                            |

A resource ID is a type prefix and the IDs that the resource belongs to, joined with `:`, as `resourceId()` in `@notation/aws` builds it. For example, a Lambda's role is `lambda:<lambda id>:role`, and a queue is `sqs-queue:<queue id>`. An `id` can't contain `:`, so two resources get the same ID only when they have the same type and the same IDs. Only the last part may contain `:`, such as the path in a route's ID. The mapping from a queue to a Lambda is a resource in the `QueueGroup`, with the ID `sqs-mapping:<queue id>:<lambda id>`. API integrations and permissions are resources in the `LambdaGroup`, with IDs such as `api-integration:<api id>:<lambda id>`.

`add()` records the group on the resource as `resource.group`, a `ResourceGroupRef`:

```ts
type ResourceGroupRef = {
  type: string;
  id: string;
  parents: { type: string; id: string }[]; // outermost first; [] at the top level
};
```

A resource that is in no group has `group: null`. The reconciler persists the ref with each resource's state. The group is not part of the resource's key, so a deployed resource that moves into a group, out of one, to another group, or under other parents keeps its remote resource. The next deploy writes the new ref to the record without calling `update`.

Groups don't declare dependencies. Edges between groups follow from the dependencies of the resources they contain, since each resource records its group.

`addOnce` adds a resource unless the group already has one with the same ID, and returns the one the group holds. Use it for resources that bind two others, such as an API integration, which several call sites may create. It throws if the existing resource has a different class.

A group is optional. Every resource that is constructed while infra is evaluated joins the graph, with `group: null`, and deploy and destroy include it. The graph lists resources in the order they were constructed. When a group adds a resource that is already in the graph, `add()` sets the resource's group and leaves it in place. Adding a resource to a second group, or to the same group twice, throws.

A resource that is constructed while no graph is being collected joins no graph. If a group adds it during collection, it joins the graph then. Code that calls the reconciler directly, such as `examples/reconciler`, passes such resources in `resources`.

Groups are collected during graph construction too. This is how a construct like `export const external = lambda({ ... })` maps to the 4–6 actual AWS resources required to run it, under one group.

### Nested groups

A group that builds on another group adds it with the same `add()`. For example, a router that keeps its routes in a `kvJson()` document holds the `KVJsonGroup`, and so the `kv.KVJsonValue` resource in it:

```ts
class Router extends ResourceGroup {
  readonly routes: KVJsonGroup<typeof Routes>;

  constructor(id: string, namespace: KVNamespaceInstance) {
    super("router", id);
    this.routes = this.add(
      kvJson({ id: "routes", namespace, key: "routes", schema: Routes }),
    );
  }
}
```

`new Router("main", namespace)` gives this tree:

```text
router main
└── cloudflare/kv/json routes
    └── kv-json:routes      group: { type: "cloudflare/kv/json", id: "routes",
                                     parents: [{ type: "router", id: "main" }] }
```

`kvJson()` adds the `kv.KVJsonValue` in its constructor, before `Router` adds the `KVJsonGroup`. **`add()` rewrites the refs of every resource below the added group**, so the resource's `parents` name the router even though the resource joined its group first. A group's parent can't change once it is set, so the refs stay correct from then on.

The rules of nesting:

- **A group has at most one parent.** Adding a group that already has a parent throws, as adding a resource to a second group does.
- **A group can't contain itself.** Adding a group to itself, or to a group that it contains at any depth, throws.
- **Only `add()` sets a parent.** A group that is constructed inside another group's constructor, but not added, stays at the top level.
- **Nesting has no depth limit.** `parents` lists every ancestor.
- **IDs stay unique across the whole graph.** Nesting doesn't scope a group's ID: two groups of the same type can't share an ID, even under different parents.

`group.groups` lists the groups that were added to it, `group.parent` is the ref of its parent or `null`, and `group.ref` is the group's own ref, the one its resources record. `resourceGroups` in the graph lists every group, nested or not; the groups whose `parent` is `null` are the roots of the tree. `notation viz` draws each nested group as a Mermaid subgraph inside its parent's.

As for resources, a group that is constructed while no graph is being collected joins the graph when a group in the graph adds it, together with its resources and nested groups.
