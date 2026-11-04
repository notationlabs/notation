# Reading Infra Values

Runtime code often needs a value that infra declares, such as the URL of a queue. A runtime module imports the infra module `with { type: "infra" }`, and reads the value as an ordinary property.

This page uses the SQS example. `infra/orders.ts` declares a queue, and the checkout function sends each new order to it:

::code-group

```ts [runtime/checkout.fn.ts]
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "infra/orders" with { type: "infra" };

const sqs = new SQSClient();

const { handle } = lambda({
  id: "checkout",
  timeout: 5,
  grants: [orderQueue.grant(["SendMessage"])],
});

export const createOrder = handle.apiRequest(async (req) => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: orderQueue.url, // string
      MessageBody: req.body ?? "{}",
    }),
  );
  return json({ ok: true });
});
```

```ts [infra/orders.ts]
import { api, router } from "@notation/aws/api-gateway";
import { queue } from "@notation/aws/sqs";
import { createOrder } from "runtime/checkout.fn" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });

const ordersApi = router(api({ name: "orders-api" }));
ordersApi.post("/orders", createOrder);
```

::

In infra code, `orderQueue.url` is an [output value](../internals/resource.md#output-values): a token that stands for a URL that doesn't exist until AWS creates the queue. In runtime code, `orderQueue.url` is the URL itself, typed as `string`. The deployed function receives the URL when it deploys.

The two modules import each other. This is allowed: the compiler runs every infra module before any runtime module. See [Compiler](../internals/compiler.md).

## What runtime code sees

[`notation types`](../cli/types.md) writes the declarations that give runtime code its view of an infra module. The view follows these rules:

| In the infra module                                         | In runtime code                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| An output value, such as `orderQueue.url`                   | The value's type, such as `string`                           |
| Data, such as a string or a plain object                    | The same type                                                |
| A resource factory, such as `lambda` or `queue`             | Callable, for use in [`lambda()` settings](./function-config.md) |
| A `grant` method, such as `orderQueue.grant`                | Callable, for use in `grants`                                |
| Any other function or method, such as `orderQueue.consume`  | Uncallable                                                   |

So `orderQueue.consume(createOrder)` in runtime code is a type error.

## How a read reaches the function

The compiler builds the function's bundle from runtime code only. It rewrites each read of an infra import into a call that looks the value up when the function runs:

```ts
orderQueue.url;
// becomes
read("infra/orders#orderQueue", ["url"]);
```

`infra/orders#orderQueue.url` is the read's output key. It has three parts:

| Part          | Example        | Meaning                                                                    |
| ------------- | -------------- | -------------------------------------------------------------------------- |
| Module        | `infra/orders` | The infra module's path from the project root, without its extension.      |
| Binding       | `#orderQueue`  | The export of the infra module.                                            |
| Property path | `.url`         | The property that runtime code reads. Nested reads use more dots.          |

Then the values travel in four steps:

1. The compiler lists the output keys that the finished bundle reads, in `reads.json` next to the bundle. The bundle is tree-shaken first, so a read in dead code isn't listed.
2. `notation plan` and `notation deploy` find the value of each listed key in infra. For `orderQueue.url`, the value is the queue's URL output.
3. The values go in the function's `NOTATION_RUNTIME` environment variable, next to its [dispatch map](../resources/lambda.md#dispatch). A plan shows them as a change to `Environment.Runtime`, and an output that isn't known yet shows as unknown.
4. When the function runs, `read` looks the key up in the variable.

`NOTATION_RUNTIME` counts towards Lambda's limit of 4 KB of environment variables, so each read adds about the length of its key and its value.

## What runtime code can read

A read must end at an output value or at data: a string, a number, a boolean, `null`, or an array or plain object of these. Plan fails, and names the function and the key, when a read ends at anything else:

- a function of infra, such as `orderQueue.grant` stored in a variable,
- a value that infra leaves `undefined`,
- any other object, such as a class instance.

A read can go on past an output value or a string. `orderQueue.url.length` delivers the URL, and reads `length` in the function.

**A whole binding can be read as a value.** `console.log(orderQueue)` delivers the binding's data properties, such as `url` and `arn`, as one object. Its methods are left out, so the type of the binding as a value has no methods either. A namespace import, such as `import * as orders from "infra/orders"`, can't be used as a value: read one of its exports, as in `orders.orderQueue.url`.

## Rules

Some uses of infra type-check but fail the build, at the line that breaks the rule:

| Code in runtime code                                   | Error                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `orderQueue.grant(["SendMessage"])` inside a handler   | `orderQueue.grant() calls infra from runtime code.` Call it in `grants` instead. |
| `orderQueue.url = "..."`                               | `Runtime code can't change orderQueue.url, which it reads from infra.` |
| `export { orderQueue }`                                | `Runtime code can't re-export orderQueue, which it imports from infra.` |
| `import { queue } from "@notation/aws/sqs"`            | A runtime module that imports infra without `{ type: "infra" }` would bundle infra. |

## Tests

A test imports the runtime module without an attribute, and sets the values that the handler reads with `setOutputs`. The keys are the output keys above:

```ts
setOutputs({ "infra/orders#orderQueue.url": "https://sqs.test/orders" });
```

See [Testing Handlers](./testing.md).
