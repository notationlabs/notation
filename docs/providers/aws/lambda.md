# Lambda

`@notation/aws/lambda` declares Lambda functions. Most functions are declared with `$lambda` in a runtime module, next to their code, and Notation builds the code. To deploy code that Notation doesn't build, call `lambda()` in infra.

## `$lambda(config)`

A [runtime module](../../manual/file-conventions.md#runtime-modules) calls `$lambda` to declare the function that it deploys as, and exports `handler`. Infra imports the declaration and wires it:

::code-group

```ts [runtime/todos.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  event: () => apiGateway.schema(null),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  if (event.routeKey === "POST /todos") return { id: 2 };
  return [];
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoRouter = router(api({ id: "todo-api" }));
todoRouter.get("/todos", () => todos);
todoRouter.post("/todos", () => todos);
```

::

When infra has finished loading, the declaration adds a Lambda group with:

- the **Lambda function** `todos`, which runs the bundle `dist/runtime/todos/index.mjs` and calls `index.handler`,
- the **IAM execution role** `todos-role`,
- the **CloudWatch log group** `todos-log-group`, with 30-day retention,
- the **zip package** `todos-zip` of the bundle,
- the **reserved concurrency** of the function, only when `concurrency` is set.

The declaration adds the function even when nothing wires it. The options are listed in [Lambda Declaration](../../manual/function-config.md).

### Wiring a declaration

Infra APIs take the declaration as a function that returns it, such as `() => todos`. They call the function when infra has finished loading, so the runtime module and the infra module can import each other.

| Infra API                                                   | Accepts                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`eventSourceMapping`](sqs.md#eventsourcemappingconfig)     | A declaration with `sqs.schema()` or no `event`                                |
| [`router.get`](api-gateway.md#routerapi), `.post`, ...      | A declaration with `apiGateway.schema(body)` or no `event`                     |
| [`withAuthorizer`](api-gateway.md#jwt-authorization) routes | A declaration with `apiGateway.schema(body).authSchema(claims?)` or no `event` |
| [`rule`](event-bridge.md#ruleconfig)                        | A declaration with `eventBridge.schema(detail)` or no `event`                  |
| [`schedule`](event-bridge.md#scheduleconfig)                | A declaration with `eventBridge.schema(null)` or no `event`                    |

Each API also takes a Lambda group from [`lambda()`](#lambdaconfig), as it is, with no function around it.

A declaration whose event doesn't match is a type error. If TypeScript doesn't catch it, the infra API throws when infra runs, for example `route() sends apiGateway events, but the Lambda "orders" is declared with event: () => sqs.schema(schema).`

A declaration can also make its own resources, with `sqs.bind(queue)`, `apiGateway.bind(api).defineRoute(options)`, `eventBridge.bind(bus).defineRule(options)` or `eventBridge.defineSchedule(options)`. The infra APIs throw for such a declaration, so that a queue, route, rule or schedule is wired in one place.

### One handler for each function

The function has one entry point, `handler`, and Notation doesn't route events to it. In the example, both routes call the `todos` function, and the handler reads `event.routeKey` to tell them apart. A function that two queues feed reads `record.eventSourceARN` in the same way.

## IDs

Every Lambda function has an ID. It keys the function and the resources that support it in state, as `lambda:<id>`, `lambda:<id>:role`, `lambda:<id>:zip`, `lambda:<id>:policy-attachment`, `lambda:<id>:role-policy`, `lambda:<id>:log-group` and, when `concurrency` is set, `lambda:<id>:concurrency`. Changing an ID replaces the function.

In a runtime module, the ID is the declaration's `id`. The ID doesn't come from the module's path, so you can move or rename the module and keep its function.

Deploy generates the AWS names of the function and of its role when it first creates them, and keeps the names in state. The function is named `<app>--<stage>--<id>-<instance>` and its role `<app>--<stage>--<id>-role-<instance>`, where the instance is 8 random hex characters. For example, `$lambda({ id: "orders" })` is named `my-app--prod--orders-1a2b3c4d`. Each name has at most 64 characters, and a longer one is cut before the instance. See [Generated names](../../manual/project-config.md#generated-names).

IDs must be name-safe: 1 to 64 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names. `$lambda` and `lambda()` only accept string literals that follow this rule, and throw at runtime if they get anything else. Two Lambda functions in one deployment can't share an ID. IDs that differ only in case, like `myFn` and `myfn`, are two IDs.

## `lambda(config)`

Call `lambda()` to deploy code that Notation doesn't build, such as a prebuilt bundle or a Python file:

```ts [infra/lambda.ts]
import { lambda } from "@notation/aws/lambda";

export const external = lambda({
  id: "external-js",
  code: { type: "file", path: "external/lambda.mjs" },
});
```

```ts [@notation/aws/lambda]
type LambdaConfig = {
  id: string;
  handler?: string; // default "handler"
  code: { type: "file" | "zip"; path: string };
  runtime?: string; // default "nodejs22.x"
  timeout?: number;
  memory?: number;
  concurrency?: number; // reserved concurrency
};
```

Lambda calls `<file name>.<handler>`, so for `external/lambda.mjs` with the default `handler`, Lambda calls `lambda.handler`.

`lambda()` returns a Lambda group. Infra APIs take the group as it is:

```ts [infra/api.ts]
helloRouter.get("/hello", external);
```

A group has no event, so every infra API accepts it, and nothing checks that the code handles the events it receives.

## Inline policy

A Lambda function's role has an inline policy, named `<id>-role-policy`. The policy's statements are collected: each contribution adds statements, and the statements from every contribution are joined into one policy document.

A declaration adds statements with its `policy` option. For example, to let the `orders` function send to an [SQS queue](sqs.md):

```ts [runtime/orders.ts]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
  policy: () => [refundQueue.grant(["SendMessage"])],
});
```

A Lambda group from `lambda()` adds statements with `contribute`:

```ts [infra/lambda.ts]
external.policy.contribute({
  PolicyDocument: {
    Statement: [
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: orderQueue.arn },
    ],
  },
});
```

A queue that is mapped to the function, with [`sqs.bind(queue)`](sqs.md#sqsbindqueue-options) or [`eventSourceMapping()`](sqs.md#eventsourcemappingconfig), adds its read permission to the same policy.

The group creates the policy resource only when code first contributes to it. This matters because IAM rejects a policy with no statements, so a function that nothing contributes to must have no inline policy. A role's inline policies share a limit of 10,240 characters.

## Environment

A function's `Environment.Variables` is collected: any code can contribute to it, and the contributions are merged key by key. Two contributions that set one key to different values fail the plan, and the error names both contributors.

A declaration contributes the values that it binds in `env`. The function reads them with `lambda.env()`; see [Lambda Handlers](../../manual/functions.md#reading-bound-values-with-env).

```ts [runtime/orders.ts]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});
```

A Lambda group from `lambda()` contributes with `fn.contribute`:

```ts [infra/lambda.ts]
external.fn.contribute({
  Environment: { Variables: { QUEUE_URL: orderQueue.url } },
});
```

A variable that waits on an undeployed output shows as unknown at its own key in a plan, and the other variables stay visible:

```
Environment.Variables.ORDER_QUEUE_URL = (known after apply)
```

When the last contribution to `Environment` goes, the next deploy removes the function's variables.

Lambda limits a function's environment variables to 4 KB in total. If the variables are over the limit, the deploy fails with an error that names the function.

## Runtime defaults

| Setting       | Default           |
| ------------- | ----------------- |
| Runtime       | Node.js 22.x      |
| Memory        | 128 MB            |
| Timeout       | 3 seconds         |
| Concurrency   | None (unreserved) |
| Log retention | 30 days           |
