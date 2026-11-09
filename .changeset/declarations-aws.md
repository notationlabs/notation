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
  event: () => sqs.bind(ordersQueue, { batchSize: 5 }),
  policy: () => [refundsQueue.grant(["SendMessage"])],
  env: () => ({ REFUNDS_QUEUE_URL: refundsQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: order } = await lambda.decode(record);
  }
};
```

- `$lambda` in `@notation/aws/lambda` declares the function. It takes `id`, `event`, `env`, `policy`, `runtime`, `timeout` and `memory`.
- `event` names the AWS service that sends the event. Each service has a function-led form, which makes the resource from the declaration, and an infra-led form, which infra wires: `sqs.bind(queue)` or `sqs.schema(schema)`, `apiGateway.bind(api).defineRoute({ method, path, schema, auth })` or `apiGateway.schema(body)`, and `eventBridge.defineSchedule({ name, schedule })` or `eventBridge.schedule()`. A schema is any Standard Schema. It is optional on a queue and in `apiGateway.schema()`. The event kinds are `sqs`, `apiGateway`, `apiGateway-jwt` and `eventBridge`.
- `queue()` takes a `schema`. Import it from a shared module (`files.shared`), as the function loads it.
- `sqs` is an object with two methods, and it can't be called. `sqs.bind(queue, options)` maps the queue to the function, and `decode()` validates each message with the queue's schema. The options are `batchSize` and `maxBatchingWindow`. `sqs.schema(schema)` declares a function that receives SQS messages from queues that infra maps to it with `eventSourceMapping()`, and `decode()` validates each message with `schema`.
- `apiGateway.bind(api).defineRoute()` makes the route when the declaration is built. In the runtime build, the API becomes `{}` and an authorizer in `auth` becomes `{ claims }`. `router()` throws for such a declaration.
- `jwtAuthorizer({ api, issuer, audience, scopes, claims })` in `@notation/aws/api-gateway` declares a JWT authorizer, which owns its API Gateway authorizer. `router(api).withAuthorizer(authorizer)` replaces `withJWTAuthorizer(config)`, and `JWTAuthorizerConfig` and `NO_AUTH` are removed. The routes of `withAuthorizer()` accept only a declaration with `apiGateway.schema(body).authSchema(claims)`, and check that its claims schema is the authorizer's, as an object at runtime and as a type. An authorizer with no claims schema accepts any. `.authSchema()` with no claims schema accepts any authorizer. A plain router's routes accept only a declaration with no `.authSchema()`.
- `apiGateway.schema(body)` returns an event of the kind `apiGateway`. Its `authSchema(claims?)` method returns the event of the kind `apiGateway-jwt`. `authSchema` is a non-enumerable property, so it is not part of the event's data.
- `eventBridge.defineSchedule()` makes the rule and the permission when the declaration is built, and the runtime build removes its options. `schedule()` throws for such a declaration.
- `env` binds values by name. Deploy sets each one as an environment variable of the function. `lambda.env()` returns them, typed by name, and throws when one is not set. `env` must return an object literal with no spread or computed keys.
- `lambda.decode(item)` parses the JSON body of an SQS record or an API Gateway request, and validates it with the event's schema. It returns the item with `body` decoded, typed from the item that it receives. For a request through a JWT authorizer, it also returns the JWT claims as a top-level `claims` field, validated with the claims schema, or typed as `JwtClaims` with no claims schema. It leaves `requestContext` as API Gateway sent it, and the handler's event types the claims there as the loose `JwtClaims`. It throws a `DecodeError` when the body or the claims are not valid.
- `policy` adds statements to the function's role.
- `LambdaHandler<typeof lambda>` types the handler from the event, and `LambdaEnv<typeof lambda>` types the bound variables.
- `queue.consume()` is removed. Declare the function with `event: () => sqs.bind(queue)`, or map the queue in infra with `eventSourceMapping({ source: queue, target: () => lambda, batchSize })` from `@notation/aws/lambda`.
- Infra wires the declaration as a function: `eventSourceMapping({ source, target: () => lambda })`, `router(api).get("/todos", () => lambda)` and `schedule({ name, schedule, target: () => lambda })`. A Lambda group from `lambda()` is passed as it is. The wiring runs when infra has finished loading, so a runtime module and the infra that wires it can import each other. `eventSourceMapping()`, `route()`, the router methods and `schedule()` return nothing.
- Wiring a declaration whose event doesn't match fails: a queue needs an `sqs` Lambda, a route an `apiGateway` Lambda, and a schedule an `eventBridge` Lambda. A Lambda without `event` can be wired to any of them.
- `eventSourceMapping()` fails for a declaration that maps a queue itself with `sqs.bind(queue)`, and for a declaration with `sqs.schema(schema)` when the queue's schema is another object than `schema`. A queue with no schema can be mapped to a declaration with `sqs.schema()`, as the function still validates. `eventSourceMapping()` also takes a declaration with `sqs.schema()` only if its schema has the type of the queue's schema, so a mismatch is a type error. A declaration with no `event`, and a Lambda group from `lambda()`, can read any queue.
- `schedule()` takes `target` in place of `handler`, and the rule sends the EventBridge event unchanged.
- `APIGatewayJWTProxyEventV2<Claims>` in `@notation/aws/shared` keeps the whole request context, and `TypedClaimsOverride` is removed.
- The runtime build resolves `@notation/aws/lambda` to an entry without infra code, through the `notation-runtime` export condition.
- Lambda IDs are 1 to 64 letters, digits, hyphens or underscores. `lambda()` takes `timeout` and `memory`, and `handler` defaults to `"handler"`.
- `@notation/aws` recognises a Lambda group by a symbol, not by `instanceof`, so a group from another installed copy of the package passes its checks.
- `LambdaFunction` in `@notation/aws.iac` collects `Environment.Variables` from several contributors. The deploy fails if the variables are over Lambda's 4 KB limit, and the error names the function.
- `@notation/aws.iac` has an `exports` map with one entry point. Other paths, such as `@notation/aws.iac/dist/...`, no longer resolve.
- `declaredIn` and `getDeclaredIn` in `@notation/resource` record and read the module of a declaration.
