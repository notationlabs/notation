# Lambda

`@notation/aws/lambda` declares Lambda functions. Most functions come from runtime modules, and the compiler declares them for you. To deploy code that Notation doesn't build, call `lambda()` directly.

## Runtime modules

A [runtime module](../manual/file-conventions.md#runtime-modules) whose `resource.service` is `"aws/lambda"` deploys as one Lambda function:

::code-group

```ts [runtime/todos.fn.ts]
import { handle, type LambdaResource } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => []);
export const createTodo = handle.apiRequest(() => {
  id: 2;
});

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "todos",
  timeout: 5,
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getTodos, createTodo } from "runtime/todos.fn";

const todoRouter = router(api({ name: "todo-api" }));
todoRouter.get("/todos", getTodos);
todoRouter.post("/todos", createTodo);
```

::

When infra imports `runtime/todos.fn.ts`, the compiler replaces the module with a generated one. The module below is simplified: the real one gives its import and its resource aliased names, so they can't clash with the names of the module's exports.

```ts [generated module]
import { lambda } from "@notation/aws/lambda";

const resource = lambda({
  id: "todos",
  code: { type: "file", path: "dist/runtime/todos.fn/index.mjs" },
  timeout: 5,
});

export const getTodos = { resource, export: "getTodos" };
export const createTodo = { resource, export: "createTodo" };
```

`lambda()` declares:

- the **Lambda function** `todos`, which runs the bundle `dist/runtime/todos.fn/index.mjs`,
- the **IAM execution role** `todos-role`,
- the **CloudWatch log group** `todos-log-group`, with 30-day retention,
- the **zip package** `todos-zip` of the bundle.

Each export of the generated module is a `RuntimeRef`: the Lambda group, plus the name of the export to call. Infra APIs such as `router.get`, `queue.consume` and `schedule` take a `RuntimeRef`, or a Lambda group from [`lambda()`](#lambdaconfig).

```ts [@notation/aws/lambda]
type RuntimeRef = { resource: LambdaGroup; export: string };
```

TypeScript types the import from the original module, so `handle.*` returns the handler type and `RuntimeRef` together. Infra code can read `getTodos.resource` without a cast. Each infra API checks the handler type: `router.get` takes an API request handler, and `queue.consume` takes an SQS handler. A router with a JWT authorizer takes only handlers for the same claims type.

The `RuntimeRef` type also applies inside the runtime module, where it is wrong. There, `getTodos` is the handler function, and `getTodos.resource` is `undefined`. TypeScript doesn't report the mistake. Only read `resource` and `export` in infra code.

## IDs

Every Lambda function has an ID. It names the function and the resources that support it (`<id>`, `<id>-role`, `<id>-zip`, `<id>-policy`, `<id>-role-policy` and `<id>-log-group`), and keys them in state. Changing an ID replaces the function.

In a runtime module, the ID is `resource.id`. The ID doesn't come from the module's path, so you can move or rename the module and keep its function.

In AWS, the function is named `<app>--<stage>--<id>` and its role `<app>--<stage>--<id>-role`. If a name is longer than 64 characters, Notation shortens it. See [AWS names](../manual/project-config.md#aws-names).

IDs must be name-safe: 1 to 64 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names. `lambda()` only accepts string literals that follow this rule, and throws at runtime if it gets anything else. Two Lambda functions in one deployment can't share an ID. IDs that differ only in case, like `myFn` and `myfn`, count as the same, because IAM role names ignore case.

## Dispatch

A Lambda function has one entry point, but the `todos` function serves two handlers. The entry point of the runtime bundle is a `handler` export that the compiler generates:

```ts [generated runtime entry]
import * as mod from "/path/to/my-app/runtime/todos.fn.ts";
import { createDispatcher } from "@notation/aws/lambda.fn";

export const handler = createDispatcher(mod);
```

`createDispatcher` picks the export for each event:

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

The map is keyed by the ID of the route, or of the event source mapping for a queue. Notation stores the map in the function's `NOTATION_RUNTIME` environment variable, and `createDispatcher` reads it when the function starts. A plan shows each entry as a change to `Environment.Runtime`.

Lambda limits a function's environment variables to 4 KB in total, and the map counts towards the limit. The variable holds the map as JSON. A route's entry takes about 50 bytes, plus the length of its ID, the export's name and the route key. A queue's entry takes about 40 bytes, plus the length of its ID, the export's name and the queue's ARN. If the variables are over 4 KB, the deploy fails with an error that names the function. To fix it, split the runtime module into smaller modules, so that each function serves fewer routes and queues.

A schedule adds no entry. Instead, the EventBridge rule sends `{ "export": "<name>", "event": <the EventBridge event> }`, and `createDispatcher` calls the named export with the EventBridge event. Anyone allowed to invoke the function can send this shape, so the named export must be made with `handle.eventBridgeScheduledEvent`. A scheduled invocation of any other export throws.

### Events with no entry

If an event is not a scheduled invocation and has no entry in the dispatch map, the function throws an error that describes the event. This includes a request from a route that was given the module's Lambda group, such as `getTodos.resource`, instead of an export: the group is treated as external code, so the route adds no entry.

A handler is an export made with `handle.*`. Other exported functions, such as helpers, can't be the target of a scheduled invocation.

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
};
```

Lambda calls `<file name>.<handler>`, so for `external/lambda.mjs` with the default `handler`, Lambda calls `lambda.handler`.

`lambda()` returns a Lambda group. Infra APIs take the group in place of a `RuntimeRef`:

```ts [infra/api.ts]
helloRouter.get("/hello", external);
```

The code doesn't use `createDispatcher`, so a bare group adds no entry to the dispatch map, and a schedule sends the EventBridge event as it is.

## Inline policy

A Lambda group's `policy` is an inline policy on the function's role, named `<id>-role-policy`. Other code adds statements to it with `contribute`, and the statements from every contribution are joined into one policy document. For example, to let the `external` function from above send to an [SQS queue](sqs.md):

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

`NOTATION_RUNTIME` is reserved for the dispatch map. A variable with that name fails the deploy.

## Runtime defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 22.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
