# AWS Lambda

Deploy AWS Lambda functions with colocated event triggers, environment bindings, resource limits, and IAM policies. Notation bundles each runtime module into Node ESM and derives typed handlers and payload decoders from its trigger.

For package setup and AWS credential configuration, see [AWS Overview](./overview.md).

Pair a shared schema with a `$lambda` runtime module that accepts HTTP orders and pushes them onto an SQS queue, then wire the route in `infra/`:

::code-group

```ts [shared/schema.ts]
import * as v from "valibot";

export const NewOrder = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
```

```ts [runtime/create-order.ts]
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";
import { NewOrder } from "../shared/schema";

const sqsClient = new SQSClient();

export const createOrder = $lambda({
  id: "create-order",
  memory: 256,
  timeout: 10,
  event: () => apiGateway.schema(NewOrder),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
  policy: () => [orderQueue.grant(["SendMessage"])],
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  try {
    const { body: order } = await createOrder.decode(event);
    const { ORDER_QUEUE_URL } = createOrder.env();
    await sqsClient.send(
      new SendMessageCommand({ QueueUrl: ORDER_QUEUE_URL, MessageBody: JSON.stringify(order) }),
    );
    return { statusCode: 202, body: JSON.stringify({ accepted: true }) };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 400, body: JSON.stringify({ issues: error.issues }) };
  }
};
```

```ts [infra/orders.ts]
import { api, router } from "@notation/aws/api-gateway";
import { queue } from "@notation/aws/sqs";
import { createOrder } from "../runtime/create-order";
import { NewOrder } from "../shared/schema";

export const orderQueue = queue({ id: "orders", schema: NewOrder });

const ordersApi = api({ id: "orders-api" });
router(ordersApi).post("/orders", () => createOrder);
```

::

Every module calling `$lambda` must export a function named `handler` and use a unique `id`. Notation evaluates `$lambda` at deploy time to provision the function and role, while bundling `handler` with typed `decode()` and `env()` helpers (see [Declarations](../../core/declarations.md)).

## JWT protection

Chain `.authSchema(claims?)` onto `apiGateway.schema(body)` for routes guarded by `jwtAuthorizer()` (or pass `auth` to `apiGateway.bind(api).defineRoute()`):

::code-group

```ts [shared/jwt.ts]
import * as v from "valibot";

export const JWTClaims = v.object({
  sub: v.string(),
  iss: v.string(),
});
```

```ts [runtime/profile.ts]
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import { JWTClaims } from "../shared/jwt";

export const profile = $lambda({
  id: "profile",
  event: () => apiGateway.schema(null).authSchema(JWTClaims),
});

export const handler: LambdaHandler<typeof profile> = async (event) => {
  try {
    const { claims } = await profile.decode(event);
    return { sub: claims.sub, iss: claims.iss };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: error.part === "claims" ? 403 : 400, body: error.message };
  }
};
```

```ts [infra/api.ts]
import { api, jwtAuthorizer, router } from "@notation/aws/api-gateway";
import { profile } from "../runtime/profile";
import { JWTClaims } from "../shared/jwt";

const ordersApi = api({ id: "orders-api" });
const auth = jwtAuthorizer({
  id: "orders-auth",
  api: ordersApi,
  issuer: "https://auth.example.com/",
  audience: ["orders-api"],
  claims: JWTClaims,
});

router(ordersApi).withAuthorizer(auth).get("/profile", () => profile);
```

::

Pass `null` for bodyless endpoints such as `GET` or `DELETE`, and import any shared claims schema from `shared/` so runtime and infra reference the exact same validator instance. Calling `.authSchema()` with no arguments accepts any `jwtAuthorizer()` and returns raw claims without schema validation (see [API Gateway](./api-gateway.md)).

## SQS consumers

Bind a queue directly inside `$lambda` with `sqs.bind()`, or declare `sqs.schema()` and wire `eventSourceMapping()` from `infra/`:

::code-group

```ts [runtime/orders.ts]
import { $lambda, DecodeError, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const orders = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { batchSize: 5, reportBatchItemFailures: true }),
});

export const handler: LambdaHandler<typeof orders> = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const { body: order } = await orders.decode(record);
      console.log("processing order", order.orderId);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
```

```ts [runtime/refunds.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { Refund } from "../shared/schema";

export const refunds = $lambda({
  id: "refunds",
  event: () => sqs.schema(Refund),
});

export const handler: LambdaHandler<typeof refunds> = async (event) => {
  for (const record of event.Records) {
    const { body: refund } = await refunds.decode(record);
    console.log("refund", refund.orderId, refund.reason);
  }
};
```

```ts [infra/orders.ts]
import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { refunds } from "../runtime/refunds";
import { NewOrder, Refund } from "../shared/schema";

export const orderQueue = queue({ id: "orders", schema: NewOrder });
export const refundQueue = queue({ id: "refunds", schema: Refund });

eventSourceMapping({
  source: refundQueue,
  target: () => refunds,
  batchSize: 10,
});
```

::

Both forms automatically grant `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on the queue ARN. Self-bound `$lambda` functions cannot also be passed to `eventSourceMapping()` (see [AWS SQS](./sqs.md)).

## EventBridge triggers

Bind EventBridge pattern rules or schedules inside `$lambda` with `eventBridge.bind(bus).defineRule()` or `eventBridge.defineSchedule()`, or wire `eventBridge.schema()` from `infra/` (see [Amazon EventBridge](./event-bridge.md)):

::code-group

```ts [runtime/fulfil-order.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { ordersBus } from "../infra/orders";
import { NewOrder } from "../shared/schema";

export const fulfilOrder = $lambda({
  id: "fulfil-order",
  event: () =>
    eventBridge.bind(ordersBus).defineRule({
      id: "order-placed",
      pattern: { source: ["shop"], "detail-type": ["OrderPlaced"] },
      schema: NewOrder,
    }),
});

export const handler: LambdaHandler<typeof fulfilOrder> = async (event) => {
  const { detail: order } = await fulfilOrder.decode(event);
  console.log("fulfil", order.orderId);
};
```

```ts [runtime/nightly-digest.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { rate } from "@notation/aws/event-bridge";

export const nightlyDigest = $lambda({
  id: "nightly-digest",
  event: () =>
    eventBridge.defineSchedule({
      id: "nightly-digest",
      schedule: rate(1, "day"),
    }),
});

export const handler: LambdaHandler<typeof nightlyDigest> = async (event) => {
  console.log("digest at", event.time);
};
```

::

On scheduled functions (`schema: null`) or functions without an `event`, `decode()` is disabled at compile time and throws at runtime.

## Environment variables

Return an object literal with static keys (no spreads or computed keys) from `env: () => ({ ... })`, then call `fn.env()` inside your handler to read cached strings from `process.env`. `fn.env()` throws if any bound variable is missing or if called outside the runtime build.

When unit testing handlers that call `fn.env()`, pass `--conditions=notation-runtime` to your test runner. Notation also rejects deployments whose serialized environment variables exceed AWS Lambda's `4,096`-byte limit.

## IAM policies

Every Lambda receives an execution role with the `lambda.amazonaws.com` assume-role trust policy and `AWSLambdaBasicExecutionRole` for CloudWatch Logs access. Add least-privilege permissions in `policy: () => [...]` using `.grant()` helpers or explicit policy statements with `text` for dynamic ARNs:

```ts [runtime/publish-order.ts]
import { $lambda, apiGateway } from "@notation/aws/lambda";
import { text } from "@notation/resource";
import { ordersBus } from "../infra/orders";
import { NewOrder } from "../shared/schema";

export const publishOrder = $lambda({
  id: "publish-order",
  event: () => apiGateway.schema(NewOrder),
  env: () => ({ ORDERS_BUS_NAME: ordersBus.name }),
  policy: () => [
    ordersBus.grant(["PutEvents"]),
    {
      Effect: "Allow",
      Action: ["ssm:GetParameter"],
      Resource: text`arn:aws:ssm:*:*:parameter/${ordersBus.name}/*`,
    },
  ],
});
```

Notation creates the inline role policy resource only when at least one statement is present because IAM rejects empty policy documents.

## External code

Use `lambda()` in `infra/` for external files, `.zip` archives, non-Node runtimes, or custom [bundles](../../authoring/bundles.md), then configure environment variables and permissions via [contributions](../../core/outputs-and-contributions.md):

```ts [infra/external.ts]
import { lambda } from "@notation/aws/lambda";
import { bundle } from "@notation/build/resources";
import { orderQueue } from "./orders";

export const pythonWorker = lambda({
  id: "python-worker",
  runtime: "python3.12",
  code: { type: "file", path: "external/worker.py" },
});

const webhookBundle = bundle({
  id: "webhook-bundle",
  platform: "node",
  entry: "external/webhook.ts",
});

export const webhook = lambda({ id: "webhook", code: webhookBundle, memory: 256, timeout: 15 });

webhook.fn.contribute({ Environment: { Variables: { ORDER_QUEUE_URL: orderQueue.url } } });
webhook.policy.contribute({ PolicyDocument: { Statement: [orderQueue.grant(["SendMessage"])] } });
```

For external TypeScript handlers bundled with `bundle()`, `@notation/aws/lambda` exports standalone handler types backed by `@types/aws-lambda`:

```ts [external/webhook.ts]
import type { ApiGatewayHandler } from "@notation/aws/lambda";

export const handler: ApiGatewayHandler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ path: event.rawPath }),
  };
};
```

Pass `LambdaGroup` values returned by `lambda()` directly to trigger builders (`router()`, `eventSourceMapping()`, `rule()`, `schedule()`) without wrapping them in a thunk.

## Reference

### Runtime declaration options

`$lambda(config)` accepts `LambdaDeclarationConfig`:

| Option | Description |
| :--- | :--- |
| `id` | Required `NameSafe<Id>` string identifying the function |
| `event` | Optional `() => LambdaEvent` thunk returning an `apiGateway`, `sqs`, or `eventBridge` trigger |
| `env` | Optional `() => EnvVars` thunk returning an object literal with static keys read via `fn.env()` |
| `policy` | Optional `() => PolicyStatement[]` thunk returning IAM statements for the execution role |
| `runtime` | Optional `Runtime` identifier; defaults to `"nodejs22.x"` |
| `timeout` | Optional `number` for maximum execution duration in seconds; defaults to `3` |
| `memory` | Optional `number` for memory allocation in MB; defaults to `128` |
| `concurrency` | Optional `number` for reserved concurrent executions |

`id` must be `1` to `64` characters matching `[A-Za-z0-9_-]`, and changing it replaces the function. `concurrency` accepts `0` or greater, where `0` stops all invocations.

### External function options

`lambda(config)` accepts `LambdaConfig`:

| Option | Description |
| :--- | :--- |
| `id` | Required `NameSafe<Id>` string identifying the function |
| `code` | Required `{ type: "file" \| "zip"; path: string }` object or `BundleLike` from `bundle()` |
| `handler` | Optional `string` naming the exported handler; defaults to `"handler"` |
| `runtime` | Optional `Runtime` identifier; defaults to `"nodejs22.x"` |
| `timeout` | Optional `number` for maximum execution duration in seconds; defaults to `3` |
| `memory` | Optional `number` for memory allocation in MB; defaults to `128` |
| `concurrency` | Optional `number` for reserved concurrent executions |

`code` accepts a source file to zip, a prebuilt `.zip` archive, or a `bundle()` built with `platform: "node"`. `id` must be `1` to `64` characters matching `[A-Za-z0-9_-]`, and changing it replaces the function.

### Resource group properties

`lambda()` returns a `LambdaGroup` (detectable with `isLambdaGroup(value)`):

| Property | Description |
| :--- | :--- |
| `fn` | Underlying `LambdaFunction` resource accepting `.contribute()` |
| `role` | Underlying `LambdaIamRole` execution role resource |
| `policy` | Lazy `LambdaRolePolicy` created when accessed to contribute statements |

Each `LambdaGroup` also provisions a `LambdaRolePolicyAttachment` (`AWSLambdaBasicExecutionRole`) and a `LambdaLogGroup` (`/aws/lambda/<FunctionName>`, `retentionInDays: 30`).

### Trigger builders

`@notation/aws/lambda` exports three trigger builders and an infra mapping helper:

| Helper | Description |
| :--- | :--- |
| `apiGateway.schema(body)` | Decoupled HTTP trigger with `.authSchema(claims?)` for JWT routes |
| `apiGateway.bind(api).defineRoute(options)` | Self-bound HTTP route on an `api()` group |
| `sqs.schema(schema)` | Decoupled SQS trigger wired via `eventSourceMapping()` |
| `sqs.bind(queue, options?)` | Self-bound SQS subscription with `SqsOptions` |
| `eventBridge.schema(detail)` | Decoupled EventBridge trigger for `rule()` or `schedule()` |
| `eventBridge.bind(bus).defineRule(options)` | Self-bound EventBridge pattern rule |
| `eventBridge.defineSchedule(options)` | Self-bound EventBridge schedule on the `"default"` bus |

Pass `null` to `apiGateway.schema(null)` to reject request bodies, and pass a `StandardSchemaV1` validator to `eventBridge.schema(detail)` for `rule()` or `null` for `schedule()`.

### Payload decoding

Calling `await fn.decode(item)` validates incoming payloads against the declared schema and returns a shallow copy with parsed fields:

| Source | Behavior |
| :--- | :--- |
| API Gateway | Decodes optional base64 JSON `body` and validates JWT `claims` when configured |
| SQS | Parses `record.body` as JSON on one `SQSRecord` and returns `{ ...record, body }` |
| EventBridge | Validates `event.detail` directly without JSON parsing and returns `{ ...event, detail }` |

If JSON parsing, JWT claim extraction, or schema validation fails, `decode()` throws `DecodeError` with `part` (`"body" | "claims" | "detail"`) and `issues` (`ReadonlyArray<StandardSchemaV1.Issue>`, empty when JSON parsing fails).

### Derived types

`@notation/aws/lambda` exports these types for `$lambda` declarations and policies:

| Type | Description |
| :--- | :--- |
| `Lambda<E, Env>` | Return handle exposing `id`, `env()`, and `decode()` |
| `LambdaHandler<typeof fn>` | Derives the Lambda `event` and return type from a `$lambda` declaration |
| `LambdaEnv<typeof fn>` | Extracts `Readonly<Env>` with refs and derived values resolved to `string` |
| `EnvVars` | `Record<string, Input<string> \| CredentialRef<string>>` |
| `PolicyStatement<R>` | IAM statement supporting `Input<string>` values in `Resource` and `NotResource` |

`LambdaHandler<typeof fn>` maps each trigger to its AWS event and return type (`APIGatewayProxyEventV2` or `APIGatewayJWTProxyEventV2<JwtClaims>` returning `ApiGatewayResult`, `SQSEvent` returning `void` or `SQSBatchResponse`, `EventBridgeEvent` returning `void | Promise<void>`, or `unknown`). `PolicyStatement<R = Input<string>>` resolves `R` to `string` in `ResolvedPolicyStatement`.

### Standalone handler types

`@notation/aws/lambda` exports standalone handler types for `lambda()` and custom bundles:

| Type | Description |
| :--- | :--- |
| `ApiGatewayHandler` | HTTP v2 handler returning `ApiGatewayResult \| Promise<ApiGatewayResult>` |
| `ApiGatewayResult` | `APIGatewayProxyResultV2<object \| number \| boolean \| null>` |
| `JWTAuthorizedApiGatewayHandler<ClaimsType>` | Handler typed with `APIGatewayJWTProxyEventV2<ClaimsType>` |
| `APIGatewayJWTProxyEventV2<T>` | HTTP v2 event with `requestContext.authorizer.jwt.claims` typed as `T` |
| `JwtClaims` | Raw API Gateway JWT claims map |
| `SqsHandler` | Standard SQS handler returning `void \| Promise<void>` |
| `SqsBatchHandler` | Batch-failure SQS handler taking `SQSBatchResponse` |
| `EventBridgeHandler<TypeDescription, DetailType>` | EventBridge rule handler returning `void \| Promise<void>` |
| `EventBridgeScheduleHandler` | Alias for `EventBridgeHandler<"Scheduled Event", any>` |
| `DynamoDbStreamHandler` | DynamoDB stream handler returning `void \| Promise<void>` |
| `DynamoDbBatchHandler` | Batch-failure DynamoDB stream handler taking `DynamoDBBatchResponse` |
