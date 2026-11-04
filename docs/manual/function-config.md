# Function Settings

A runtime module calls `lambda()` to declare the Lambda function that its handlers run in. The arguments of `lambda()` are the function's settings. This page uses the checkout module from the SQS example:

```ts [runtime/checkout.fn.ts]
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "infra/orders" with { type: "infra" };

const { handle } = lambda({
  id: "checkout",
  timeout: 5,
  grants: [orderQueue.grant(["SendMessage"])],
});

export const createOrder = handle.apiRequest(async (req) => {
  // send req.body to orderQueue.url
  return json({ ok: true });
});
```

`lambda` comes from `@notation/aws/lambda`, the same factory that infra code calls. The runtime module imports it `with { type: "infra" }`, because the call declares infra. `lambda()` returns `{ handle }`, and each handler that `handle` makes and the module exports runs in the `checkout` function. See [Lambda Handlers](./functions.md).

## Settings

```ts [@notation/aws/lambda]
type LambdaConfig = {
  id: string;
  timeout?: number; // seconds
  memory?: number; // megabytes
  runtime?: string; // such as "nodejs22.x"
  grants?: PolicyStatement[];
};
```

| Setting   | Meaning                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `id`      | Names the function and the resources that support it, and keys them in state. Required.                    |
| `timeout` | The seconds that the function may run for each event.                                                       |
| `memory`  | The megabytes of memory that the function gets.                                                             |
| `runtime` | The Lambda runtime.                                                                                         |
| `grants`  | Policy statements for the function's role, such as `orderQueue.grant(["SendMessage"])`. See [Grants](#grants). |

`lambda()` also takes `code` and `handler`, for a function that runs code that Notation doesn't build. Leave them out in a runtime module: the compiler bundles the module's handlers to `dist/functions/<id>/index.mjs`. See [Lambda](../resources/lambda.md#external-code).

**The settings apply to every handler that this `lambda()` call makes.** If one handler needs more memory or a longer timeout than the others, declare a second function for it. See [Several functions](#several-functions).

## `id`

`id` names the function, its IAM role and its log group, and keys them in state. The ID doesn't depend on the module's path, so you can move or rename the module and keep its function. Changing the ID replaces the function.

Use 1 to 64 letters, digits, hyphens and underscores. Two functions in one deployment can't share an ID. See [Lambda IDs](../resources/lambda.md#ids).

The type of `id` must be a string literal, so that TypeScript can check its characters. A constant declared with `const` works:

```ts
const id = "checkout";
const { handle } = lambda({ id, timeout: 5 });
```

## Grants

A grant is a policy statement that lets the function use a resource. Each resource that can grant access has a `grant()` method that returns one statement. `grants` adds the statements to the function's [inline policy](../resources/lambda.md#inline-policy):

```ts [runtime/checkout.fn.ts]
const { handle } = lambda({
  id: "checkout",
  grants: [orderQueue.grant(["SendMessage"])],
});
```

The grant sits in the settings, next to the code that sends to the queue. The infra module that declares `orderQueue` doesn't mention the checkout function.

**Grants only work in the settings.** Runtime code sees each infra function as uncallable, except resource factories such as `lambda` and `grant` methods. A call to `orderQueue.grant()` inside a handler type-checks, because `grant` stays callable, but the build fails at the call:

```
orderQueue.grant() calls infra from runtime code. Infra functions only run in the infra phase: call them in the settings of lambda(), as in grants: [orderQueue.grant(["SendMessage"])].
```

## Settings are ordinary code

The compiler runs the settings while it builds infra, after every infra module has run. So the settings can use infra values, local constants and helper functions:

```ts [runtime/reports.fn.ts]
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue, refundQueue } from "infra/orders" with { type: "infra" };

const baseMemory = 128;
const sendTo = (queues: (typeof orderQueue)[]) =>
  queues.map((queue) => queue.grant(["SendMessage"]));

const { handle } = lambda({
  id: "reports",
  memory: baseMemory * 2,
  grants: sendTo([orderQueue, refundQueue]),
});
```

The compiler doesn't run the whole module to read the settings. It runs a stripped copy of the module, which keeps the `lambda()` call, the handlers made from it, and the code that they reference. Handler bodies, top-level `await`, SDK clients and logging are removed. So in the starter template, `await api.get("/todos")` at the top of `runtime/todos.fn.ts` runs only in the deployed function.

**The stripped copy loses effects that the settings don't reference.** For example:

- A side-effect import, such as `import "./env-setup"` that sets a global, is removed. If the settings read that global, the setting is `undefined`, and there is no error.
- A call that changes a value, such as `bump()` changing a counter that the settings read, is removed.

To keep a value, reference it from the settings directly, for example by importing it from the module that computes it. See [Compiler](../internals/compiler.md) for the rules that decide what the copy keeps.

## Several functions

Each `lambda()` call declares one function, and each function's bundle dispatches only to the handlers made by its own `handle`. One module can call `lambda()` more than once:

```ts [runtime/reports.fn.ts]
const quick = lambda({ id: "reports-api", timeout: 5 });
const heavy = lambda({ id: "reports-build", timeout: 300, memory: 1024 });

export const getReport = quick.handle.apiRequest(() => json({}));
export const buildReport = heavy.handle.eventBridgeScheduledEvent(() => {});
```

A `lambda()` call can also sit in a helper module or behind a condition. The compiler finds functions by running the calls, not by reading the source.

**Each handler must be exported** from a runtime module that infra imports. A handler that no runtime module exports fails at plan, and the error names its `handle` call.

## Exporting the function

A runtime module can export the result of `lambda()`. Infra then sees the export typed as the function's Lambda group, and can pass it to infra APIs that take a group:

```ts [runtime/checkout.fn.ts]
export const checkoutFn = lambda({ id: "checkout", timeout: 5 });
export const createOrder = checkoutFn.handle.apiRequest(() => json({}));
```

```ts [infra/api.ts]
import { checkoutFn } from "runtime/checkout.fn" with { type: "runtime" };
```

Wire handlers, not the group. A route or a queue that gets the group adds no entry to the function's dispatch map, so the function can't tell which handler to call. See [Dispatch](../resources/lambda.md#dispatch).

Infra can also reach the function through any of its handlers, as `createOrder.function`. Both are stand-ins while infra is being evaluated: infra can pass them to infra APIs, but can't read their properties, such as the ID or the policy. See [Lambda](../resources/lambda.md#the-function-of-a-handler).

## The `resource` export

Earlier versions declared the function with an exported `resource` object. A runtime module that still exports `resource` fails the build with a message that shows the `lambda()` call to use instead.

## Defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 22.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
