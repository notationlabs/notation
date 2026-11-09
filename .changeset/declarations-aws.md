---
"@notation/aws": minor
"@notation/aws.iac": minor
"@notation/resource": minor
---

A runtime module declares the Lambda function that it deploys as, next to the function's code (RFC 0015). The code is written with Lambda's own API, and the module exports `handler`.

```ts
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { ordersQueue, refundsQueue } from "../infra/orders";

export const lambda = $lambda({
  id: "process-orders",
  event: () => sqs(ordersQueue, { batchSize: 5 }),
  policy: () => [refundsQueue.grant(["SendMessage"])],
  env: () => ({ REFUNDS_QUEUE_URL: refundsQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const order = await lambda.decode(record);
  }
};
```

- `$lambda` in `@notation/aws/lambda` declares the function. It takes `id`, `event`, `env`, `policy`, `runtime`, `timeout` and `memory`.
- `event` is `() => sqs(queue)`, `() => http({ body: schema })` or `() => scheduled()`. A schema is any Standard Schema, and is optional.
- `queue()` takes a `schema`. Import it from a shared module (`files.shared`), as the function loads it.
- `sqs(queue, options)` maps the queue to the function, and `decode()` validates each message with the queue's schema. The options are `batchSize` and `maxBatchingWindow`. `sqs()` with no queue declares a function that receives SQS messages from a mapping in infra, and `decode()` doesn't validate them. `sqs(schema)` is not supported: put the schema on the queue.
- `http({ auth: jwt<Claims>() })` declares a function whose routes have a JWT authorizer. `LambdaHandler` types the claims in its event as `Claims`. The routes of `withJWTAuthorizer()` accept only these declarations, and a plain router's routes reject them.
- `env` binds values by name. Deploy sets each one as an environment variable of the function. `lambda.env()` returns them, typed by name, and throws when one is not set. `env` must return an object literal with no spread or computed keys.
- `lambda.decode(item)` parses the JSON body of an SQS record or an HTTP request, and validates it with the event's schema. It throws a `DecodeError` when the body is not valid.
- `policy` adds statements to the function's role.
- `LambdaHandler<typeof lambda>` types the handler from the event, and `LambdaEnv<typeof lambda>` types the bound variables.
- `queue.consume()` is removed. Declare the function with `event: () => sqs(queue)`, or map the queue in infra with `eventSourceMapping({ source: queue, target: () => lambda, batchSize })` from `@notation/aws/lambda`.
- Infra wires the declaration as a function: `eventSourceMapping({ source, target: () => lambda })`, `router.get("/todos", () => lambda)` and `schedule({ name, schedule, target: () => lambda })`. A Lambda group from `lambda()` is passed as it is. The wiring runs when infra has finished loading, so a runtime module and the infra that wires it can import each other. `eventSourceMapping()`, `route()`, the router methods and `schedule()` return nothing.
- Wiring a declaration whose event doesn't match fails: a queue needs an SQS Lambda, a route an HTTP Lambda, and a schedule a scheduled Lambda. A Lambda without `event` can be wired to any of them.
- `eventSourceMapping()` fails for a declaration that maps a queue itself with `sqs(queue)`, and for a declaration when the queue has a schema, as the function would not validate messages with it. A Lambda group from `lambda()` can read a queue with a schema.
- `schedule()` takes `target` in place of `handler`, and the rule sends the EventBridge event unchanged.
- `withJWTAuthorizer()` no longer takes a claims type. Declare the claims with `http({ auth: jwt<Claims>() })`.
- `APIGatewayJWTProxyEventV2<Claims>` in `@notation/aws/shared` keeps the whole request context, and `TypedClaimsOverride` is removed.
- The runtime build resolves `@notation/aws/lambda` to an entry without infra code, through the `notation-runtime` export condition.
- Lambda IDs are 1 to 64 letters, digits, hyphens or underscores. `lambda()` takes `timeout` and `memory`, and `handler` defaults to `"handler"`.
- `@notation/aws` recognises a Lambda group by a symbol, not by `instanceof`, so a group from another installed copy of the package passes its checks.
- `LambdaFunction` in `@notation/aws.iac` collects `Environment.Variables` from several contributors. The deploy fails if the variables are over Lambda's 4 KB limit, and the error names the function.
- `@notation/aws.iac` has an `exports` map with one entry point. Other paths, such as `@notation/aws.iac/dist/...`, no longer resolve.
- `declaredIn` and `getDeclaredIn` in `@notation/resource` record and read the module of a declaration.
