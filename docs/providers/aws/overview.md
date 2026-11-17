# AWS Overview

`@notation/aws` deploys AWS serverless infrastructure in TypeScript alongside your application handlers. High-level constructs derive IAM roles, least-privilege policies, and typed event contracts automatically, while `@notation/aws/resources` exposes low-level AWS SDK resources when you need direct control.

## Installation

Install `@notation/core`, `@notation/aws`, and `valibot` (or any Standard Schema validator) into your project:

```sh [Terminal]
@pm.add("@notation/core", "@notation/aws", "valibot")
```

If you are setting up a project without `create-notation`, also install `@notation/cli` and `@types/node` so the CLI commands and Node Lambda types are available.

Configure the project name, infrastructure entry point, and default stage in `notation.config.ts` (see [Project Config](../../core/project-config.md)):

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-service",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

## AWS credentials

Offline commands such as `notation compile` and `notation viz` do not contact AWS. Commands that read or update cloud state (`notation plan`, `notation deploy`, `notation watch`, and `notation destroy`) use the standard AWS SDK v3 credential provider chain:

- **Named profiles** – Configured via `AWS_PROFILE` and `~/.aws/credentials` or `~/.aws/config`, including AWS SSO profiles.
- **Environment variables** – Configured via `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`.
- **IAM roles** – Provided automatically via OIDC or instance metadata in CI/CD runners, EC2 instances, or ECS tasks.

## AWS region

`@notation/aws` has no fallback region and throws immediately if `AWS_REGION` is unset. Export `AWS_REGION` (and optionally `AWS_PROFILE`) in your shell before running commands against AWS:

```sh [Terminal]
export AWS_REGION=eu-north-1
export AWS_PROFILE=dev
```

## First deployment

Colocate a `$lambda` declaration and its handler in `runtime/orders.ts`, then wire an HTTP API route to it from `infra/api.ts`:

::code-group

```ts [runtime/orders.ts]
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import * as v from "valibot";

const CreateOrder = v.object({
  item: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const lambda = $lambda({
  id: "create-order",
  event: () => apiGateway.schema(CreateOrder),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  try {
    const { body } = await lambda.decode(event);
    return { statusCode: 201, body: JSON.stringify({ created: body }) };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 400, body: JSON.stringify({ issues: error.issues }) };
  }
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as createOrder } from "../runtime/orders";

const ordersApi = api({ id: "orders-api" });
router(ordersApi).post("/orders", () => createOrder);
```

::

Deploy the API, Lambda, IAM execution role, and CloudWatch log group to your default stage:

```sh [Terminal]
@pm.run("deploy")
```

Notation compiles runtime modules separately from infrastructure declarations (see [Modules](../../core/modules.md)).

## Extending constructs

High-level constructs return resource groups whose underlying resources accept `.contribute()` overrides when you need to attach environment variables, IAM statements, or SDK fields:

```ts [infra/orders.ts]
import { lambda } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import * as v from "valibot";

export const orderQueue = queue({
  id: "orders",
  schema: v.object({ orderId: v.string() }),
});

const orderProcessor = lambda({
  id: "process-orders",
  code: { type: "file", path: "dist/process-orders.js" },
});

orderProcessor.fn.contribute({
  Environment: { Variables: { ORDER_QUEUE_URL: orderQueue.url } },
});

orderProcessor.policy.contribute({
  PolicyDocument: { Statement: [orderQueue.grant(["SendMessage"])] },
});
```

## Reference

### Package subpaths

`@notation/aws` exposes each AWS service and resource layer under its own subpath export:

| Export | Description |
| :--- | :--- |
| `@notation/aws/lambda` | [AWS Lambda](./lambda.md) declarations, resources, and event mappings |
| `@notation/aws/api-gateway` | [API Gateway](./api-gateway.md) APIs, routers, and JWT authorizers |
| `@notation/aws/sqs` | [AWS SQS](./sqs.md) queues and dead-letter configuration |
| `@notation/aws/event-bridge` | [Amazon EventBridge](./event-bridge.md) buses, rules, and schedules |
| `@notation/aws/resources` | Low-level AWS SDK resource classes across all services |

### Lambda resources

Import `lambda` from `@notation/aws/resources` for low-level Lambda resource classes when authoring [custom resources](../../authoring/resources.md) or overriding unsupported SDK fields:

| Resource | Description |
| :--- | :--- |
| `LambdaFunction` | Lambda function code, runtime, memory, timeout, and environment |
| `LambdaIamRole` | IAM execution role with a `lambda.amazonaws.com` trust policy |
| `LambdaRolePolicy` | Inline IAM policy attached to a Lambda execution role |
| `LambdaRolePolicyAttachment` | Attaches `AWSLambdaBasicExecutionRole` to a Lambda execution role |
| `LambdaLogGroup` | CloudWatch Logs group at `/aws/lambda/<FunctionName>` with retention |
| `LambdaFunctionConcurrency` | Reserved concurrent executions on a Lambda function |
| `LambdaPermission` | Resource-based invoke permission for services such as API Gateway or EventBridge |
| `LambdaEventSourceMapping` | Event source mapping with batching and scaling options |

### API Gateway resources

Import `apiGateway` from `@notation/aws/resources` for low-level API Gateway v2 HTTP API classes:

| Resource | Description |
| :--- | :--- |
| `Api` | API Gateway v2 HTTP API |
| `Stage` | API Gateway v2 stage |
| `LambdaIntegration` | `AWS_PROXY` integration between an HTTP API and a Lambda function |
| `Route` | API Gateway v2 `METHOD /path` route targeting an integration and optional authorizer |
| `RouteAuth` | API Gateway v2 JWT authorizer |

`api()` provisions an `Api` with `ProtocolType: "HTTP"` and a `$default` `Stage` with `AutoDeploy: true`. `jwtAuthorizer()` creates a `RouteAuth` with `AuthorizerType: "JWT"`.

### SQS resources

Import `sqs` from `@notation/aws/resources` for `Queue`, which manages standard or FIFO SQS queues, redrive policies, and deduplication settings.

### EventBridge resources

Import `eventBridge` from `@notation/aws/resources` for low-level EventBridge classes:

| Resource | Description |
| :--- | :--- |
| `EventBus` | Custom EventBridge event bus |
| `DefaultEventBus` | Reads the account's built-in `"default"` event bus without modifying or deleting it |
| `EventBridgeRule` | EventBridge pattern rule or schedule expression with targets and retry policy |

### Resource identifiers

Every AWS construct requires a name-safe `id` of 1 to 64 (`ID_MAX_LENGTH`) characters matching `[A-Za-z0-9_-]`. Changing an `id` replaces the AWS resource on the next [deploy](../../cli/deploy.md).

### Physical names

Top-level AWS resources generate stage-scoped physical names in the form `<app>--<stage>--<base>-<instance>`, truncated to each service limit:

| Resource | Max length |
| :--- | :--- |
| `LambdaFunction` | `64` characters on `FunctionName` |
| `LambdaIamRole` | `64` characters on `RoleName` |
| `EventBridgeRule` | `64` characters on `Name` |
| `Queue` | `80` characters on `QueueName` |
| `Api` | `128` characters on `Name` |
| `EventBus` | `256` characters on `Name` |

`LambdaLogGroup` derives `/aws/lambda/<FunctionName>`, `Queue` preserves the `.fifo` suffix when `fifo: true`, and `DefaultEventBus` always targets `"default"`. Nested resources such as `jwtAuthorizer()` omit the `<app>--<stage>--` prefix because their parent resource is already stage-scoped (see [Physical Names](../../core/physical-names.md)).
