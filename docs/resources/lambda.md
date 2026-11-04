# Lambda

`@notation/aws/lambda` declares Lambda functions with `lambda()`. Most functions are declared in runtime modules, and the compiler bundles their code. To deploy code that Notation doesn't build, call `lambda()` in infra with `code`. See [External code](#external-code).

## Runtime modules

A [runtime module](../manual/file-conventions.md#runtime-modules) imports `lambda` `with { type: "infra" }`, and calls it to declare the function that its handlers run in:

::code-group

```ts [runtime/todos.fn.ts]
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "todos", timeout: 5 });

export const getTodos = handle.apiRequest(() => json([]));
export const createTodo = handle.apiRequest(() => json({ id: 2 }));
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import {
  getTodos,
  createTodo,
} from "runtime/todos.fn" with { type: "runtime" };

const todoRouter = router(api({ name: "todo-api" }));
todoRouter.get("/todos", getTodos);
todoRouter.post("/todos", createTodo);
```

::

`lambda({ id: "todos" })` declares a Lambda group with:

- the **Lambda function** `todos`, which runs the bundle `dist/functions/todos/index.mjs`,
- the **IAM execution role** `todos-role`,
- the **CloudWatch log group** `todos-log-group`, with 30-day retention,
- the **zip package** `todos-zip` of the bundle.

The settings of `lambda()` are covered in [Function Settings](../manual/function-config.md).

### Handlers in infra

Infra imports the runtime module `with { type: "runtime" }`, so it sees each handler as a `LambdaRef`. Infra APIs such as `router.get`, `queue.consume` and `schedule` take a `LambdaRef` of the event they send, or a Lambda group:

```ts [@notation/aws/lambda]
type LambdaRef<Event> = RuntimeRef<Event, unknown, LambdaGroup>;
type HandlerTarget<Event> = LambdaRef<Event> | LambdaGroup;
```

So `router.get` takes only API request handlers, and `queue.consume` takes only SQS handlers. A router with a JWT authorizer takes only handlers for the same claims type. A `LambdaRef` isn't callable. See [End-to-End Types](../manual/types.md).

### The function of a handler

`getTodos.function` is the handler's Lambda group. All the handlers that one `handle` makes share one group, so `getTodos.function` and `createTodo.function` are the same group.

While infra is being evaluated, `getTodos` is a stand-in: the compiler runs the runtime module after every infra module, and only then links `getTodos` to its handler. Infra APIs such as `router.get` record the stand-in, and wire it once evaluation ends. `getTodos.function` is a proxy that resolves after linking. So infra can pass `getTodos.function` to an infra API, such as `router.get`, but reading a property of it while infra is being evaluated fails, and the error names the line. This includes `getTodos.function.policy`, so a function from a runtime module takes its permissions in its `grants` setting:

```
getTodos.function isn't known yet: infra used it as a value while infra was being evaluated (infra/api.ts:5:70). Infra can pass it to an infra API, but not read it.
```

## IDs

Every Lambda function has an ID. It names the function and the resources that support it (`<id>`, `<id>-role`, `<id>-zip`, `<id>-policy`, `<id>-role-policy` and `<id>-log-group`), and keys them in state. Changing an ID replaces the function.

The ID is the `id` setting of `lambda()`. The ID doesn't come from the module's path, so you can move or rename the module and keep its function.

In AWS, the function is named `<app>--<stage>--<id>` and its role `<app>--<stage>--<id>-role`. If a name is longer than 64 characters, Notation shortens it. See [AWS names](../manual/project-config.md#aws-names).

IDs must be name-safe: 1 to 64 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names. `lambda()` only accepts an `id` whose type is a string literal that follows this rule, and throws if it gets anything else. Two Lambda functions in one deployment can't share an ID. IDs that differ only in case, like `myFn` and `myfn`, count as the same, because IAM role names ignore case.

## Dispatch

A Lambda function has one entry point, but the `todos` function serves two handlers. The entry point of the function's bundle is a `handler` export that the compiler generates. The entry below is simplified: the real one names its imports `__notationHandler0` and so on.

```ts [generated function entry]
import { createDispatcher } from "@notation/aws/lambda.fn";
import { getTodos as h0 } from "/path/to/my-app/runtime/todos.fn.ts";
import { createTodo as h1 } from "/path/to/my-app/runtime/todos.fn.ts";

export const handler = createDispatcher({ getTodos: h0, createTodo: h1 });
```

The map holds the handlers that the function's `handle` made, and no other exports. `createDispatcher` picks a handler for each event:

| Event                | Export                                                           |
| -------------------- | ---------------------------------------------------------------- |
| Scheduled invocation | The export named in the event, if it is a schedule handler       |
| HTTP API request     | The export that the dispatch map gives for the API and route key |
| SQS messages         | The export that the dispatch map gives for the queue's ARN       |

### The dispatch map

A request for `GET /todos` and a request for `POST /todos` have the same shape, so the function can't tell from the event which handler to call. Only infra knows which route goes to which export. So each route adds an entry to the function's dispatch map:

```json
{
  "todo-api-GET-/todos": {
    "export": "getTodos",
    "match": { "apiId": "a1b2c3", "routeKey": "GET /todos" }
  },
  "todo-api-POST-/todos": {
    "export": "createTodo",
    "match": { "apiId": "a1b2c3", "routeKey": "POST /todos" }
  }
}
```

The map is keyed by the ID of the route, or of the event source mapping for a queue. Notation stores the map in the function's `NOTATION_RUNTIME` environment variable, and `createDispatcher` reads it when the function starts. The same variable holds the values that the function [reads from infra](../manual/infra-values.md). A plan shows each entry as a change to `Environment.Runtime`.

Lambda limits a function's environment variables to 4 KB in total, and the map counts towards the limit. The variable holds the map as JSON. A route's entry takes about 50 bytes, plus the length of its ID, the export's name and the route key. A queue's entry takes about 40 bytes, plus the length of its ID, the export's name and the queue's ARN. If the variables are over 4 KB, the deploy fails with an error that names the function. To fix it, split the handlers between several `lambda()` calls, so that each function serves fewer routes and queues.

A schedule adds no entry. Instead, the EventBridge rule sends `{ "export": "<name>", "event": <the EventBridge event> }`, and `createDispatcher` calls the named export with the EventBridge event. Anyone allowed to invoke the function can send this shape, so the named export must be a handler of this function made with `handle.eventBridgeScheduledEvent`. A scheduled invocation of any other export throws.

### Events with no entry

If an event is not a scheduled invocation and has no entry in the dispatch map, the function throws an error that describes the event. This includes a request from a route that was given a Lambda group, such as `getTodos.function`, instead of a handler: the group is treated as external code, so the route adds no entry.

## External code

Call `lambda()` in infra with `code` to deploy code that Notation doesn't build, such as a prebuilt bundle or a Python file:

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
  code?: { type: "file" | "zip"; path: string };
  runtime?: string; // default "nodejs22.x"
  timeout?: number;
  memory?: number;
  grants?: PolicyStatement[];
};
```

Lambda calls `<file name>.<handler>`, so for `external/lambda.mjs` with the default `handler`, Lambda calls `lambda.handler`.

`lambda()` returns a Lambda group. Infra APIs take the group in place of a handler:

```ts [infra/api.ts]
helloRouter.get("/hello", external);
```

The code doesn't use `createDispatcher`, so a bare group adds no entry to the dispatch map, and a schedule sends the EventBridge event as it is. A group with `code` has no `handle`: reading `external.handle` throws.

## Inline policy

A Lambda group's `policy` is an inline policy on the function's role, named `<id>-role-policy`. The `grants` setting adds statements to it, and other code adds statements with `contribute`. The statements from every contribution are joined into one policy document. For example, to let the `external` function from above send to an [SQS queue](sqs.md):

```ts [infra/lambda.ts]
external.policy.contribute({
  PolicyDocument: {
    Statement: [
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: orderQueue.arn },
    ],
  },
});
```

[`queue.consume`](sqs.md#queueconsumehandler) uses the same policy for the read permission it adds.

The group creates the policy resource only when code first reads `lambdaGroup.policy`. This matters because IAM rejects a policy with no statements, so a function that nothing contributes to must have no inline policy. A role's inline policies share a limit of 10,240 characters.

## Environment

A function's `Environment` is collected: any code can contribute to it, and the contributions are merged key by key. Two contributions that set one key to different values fail the plan, and the error names both contributors.

```ts [infra/lambda.ts]
external.fn.contribute({
  Environment: { Variables: { QUEUE_URL: orderQueue.url } },
});
```

A variable that waits on an undeployed output shows as unknown at its own key in a plan, and the other variables stay visible:

```
Environment.Variables.QUEUE_URL = (known after apply)
```

When the last contribution to `Environment` goes, the next deploy removes the function's variables.

`NOTATION_RUNTIME` is reserved for the dispatch map and the values that the function reads from infra. A variable with that name fails the deploy.

## Runtime defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 22.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
