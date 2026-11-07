# Lambda Declaration

A runtime module declares the Lambda function that it deploys as with `$lambda` from `@notation/aws/lambda`. The declaration sits next to the function's `handler` export. See [Lambda Handlers](./functions.md) for the handler, and [Runtime modules](./file-conventions.md#runtime-modules) for how Notation finds the module.

## Options

```ts [@notation/aws/lambda]
type LambdaDeclarationConfig = {
  id: string; // name-safe string literal
  event?: () => SqsEvent | HttpEvent | ScheduledEvent;
  env?: () => Record<string, string>;
  policy?: () => PolicyStatement[];
  runtime?: string; // such as "nodejs22.x"
  timeout?: number; // seconds
  memory?: number; // megabytes
};
```

| Option    | Meaning                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `id`      | Names the function and its role, zip, policy and log group, and keys them in state. See [`id`](#id).      |
| `event`   | The events that the function receives: `sqs(schema?)`, `http(schema?)` or `scheduled()`.                  |
| `env`     | Values that the function reads, by name. Deploy sets each one as an environment variable of the function. |
| `policy`  | Statements to add to the function role's inline policy.                                                   |
| `runtime` | The Lambda runtime.                                                                                       |
| `timeout` | Seconds that the function may run for each event.                                                         |
| `memory`  | Megabytes of memory for the function.                                                                     |

## Usage

```ts [runtime/orders.fn.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue, refundQueue } from "infra/orders";
import { Order } from "./schema";

export const lambda = $lambda({
  id: "orders",
  timeout: 30,
  memory: 256,
  event: () => sqs(Order),
  env: () => ({ REFUND_QUEUE_URL: refundQueue.url }),
  policy: () => [refundQueue.grant(["SendMessage"])],
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  // ...
};
```

The module deploys as one Lambda function with the ID `orders`, 256 MB of memory and a 30-second timeout. The function receives SQS messages whose bodies `lambda.decode()` validates with `Order`. The function's role may send messages to `refundQueue`, and the function reads the queue's URL with `lambda.env().REFUND_QUEUE_URL`.

The declaration doesn't connect the function to a queue. Infra does that with `orderQueue.consume(() => lambda)`. See [SQS](../resources/sqs.md#queueconsumetarget).

## Options that refer to infra are functions

`event`, `env` and `policy` are functions, such as `env: () => ({ ... })`. **Write them as functions even when they look like plain values.** A runtime module imports infra for its options, and infra imports the runtime module to wire the declaration, so the two modules import each other. Notation calls the functions after every module has loaded, so neither module reads a binding of the other while the cycle is still loading.

The types of `event`, `env` and `policy` require a function, so `env: { ... }` is a type error. Plain options, such as `memory`, can't be checked this way. A plain option that reads a value from a module in the same import cycle, such as `memory: settings.memory`, can throw a `ReferenceError` depending on which module loads first.

## The shape of the declaration

The build reads the declaration from the source, so it must have one shape:

- `$lambda` is called at the top level of the module, as `const name = $lambda({ ... })` or `export const name = $lambda({ ... })`.
- The options are an object literal with no spread, computed keys or accessors.
- `env` returns an object literal with no spread or computed keys, such as `() => ({ NAME: value })`. The runtime build keeps the names and removes the values.
- The module has one declaration.
- The module exports `handler`.

Any other form fails the build with the file and line of the call. For example, `export default $lambda({ ... })`, a declaration inside an `if`, and two declarations in one module all fail.

The declaration needs no export unless another module refers to it. In practice it is exported, because infra imports it to wire it to a queue, route or schedule.

## `id`

`id` is required. It names the function, its IAM role and its log group, and keys them in state. The ID doesn't depend on the module's path, so you can move or rename the module and keep its function. Changing the ID replaces the function.

Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. TypeScript reports an ID that breaks the rule, and `$lambda` throws on one when the infra code runs. Two Lambda functions in one deployment can't share an ID. See [Lambda IDs](../resources/lambda.md#ids).

## `env`

`env` binds values to names. You choose the names, so changing a resource's name doesn't rename them:

```ts
env: () => ({ ORDER_QUEUE_URL: orderQueue.url, LOG_LEVEL: "info" }),
```

- Each value is a string. An output value such as `orderQueue.url` is typed `string`, and deploy fills in the real URL.
- `lambda.env()` returns the values by name. In the function, it reads them from `process.env`, and throws when one is not set.
- Lambda limits a function's environment variables to 4 KB in total. If the variables are over the limit, the deploy fails with an error that names the function.

## Defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 22.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
