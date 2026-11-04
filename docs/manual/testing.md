# Testing Handlers

A test imports a runtime module without an import attribute, so each handler is a plain function that the test calls directly. The runtime module still imports infra `with { type: "infra" }`, and a test must not load that infra. Notation's loader hook serves those imports in place of the infra modules. The test sets the values that the handler reads with `setOutputs`.

This page uses the checkout module below. It reads the URL of a queue that `infra/orders.ts` declares.

```ts [runtime/checkout.ts]
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
import { sendMessage } from "./sqs-client";

const { handle } = lambda({ id: "checkout", grants: [orderQueue.grant(["SendMessage"])] });

export const createOrder = handle.apiRequest(async (req) => {
  await sendMessage(orderQueue.url, req.body ?? "");
  return json({ ok: true });
});
```

## Setting outputs

The test sets `orderQueue.url`, then calls the handler.

```ts [runtime/checkout.test.ts]
import { expect, test } from "vitest";
import { setOutputs } from "@notation/aws/testing";
import { createOrder } from "./checkout";

test("createOrder sends the order", async () => {
  setOutputs({ "infra/orders#orderQueue.url": "https://sqs.test/orders" });
  const res = await createOrder({ routeKey: "POST /orders", body: "{}" } as any, {} as any);
  expect(res).toEqual({ statusCode: 200, body: '{"ok":true}' });
});
```

Each key of `setOutputs` has three parts:

| Part | Example | Meaning |
| --- | --- | --- |
| Module | `infra/orders` | The infra module's path from the project root, without its extension. |
| Binding | `#orderQueue` | The export of the infra module. |
| Property path | `.url` | The property that runtime code reads. Nested reads use more dots, such as `.stage.url`. |

A key without a property path, such as `infra/orders#orderQueue`, sets the whole binding to an object, such as `{ url, arn }`. Each call to `setOutputs` adds to the values that earlier calls set. `clearOutputs()` removes them all.

**A read of a value that no test set throws**, and the error names the key: `No output is set for "infra/orders#orderQueue.url"`. The exception is `grant`, which stays callable, because the `lambda()` settings call it when the test imports the module.

The project root is the nearest directory above the infra module that holds `notation.config.ts`, as for `notation` commands. A `package.json` in between, such as a nested package's, doesn't stop the search.

## What the hook serves

The loader hook resolves three kinds of import differently from Node:

| Import | Served as |
| --- | --- |
| `"../infra/orders" with { type: "infra" }` | A module whose exports read the values set with `setOutputs`. `infra/orders.ts` never runs. |
| `"@notation/aws/lambda" with { type: "infra" }` | The provider's runtime half, `@notation/aws/lambda.fn`. `lambda()` then ignores its settings and returns `{ handle }`, and each handler stays a plain function. |
| `"./sqs-client"`, or `"runtime/orders.fn"` | The project's `.ts` file. Node needs an extension, and the hook resolves a bare specifier from the project root, as tsconfig `paths` such as `"runtime/*": ["./runtime/*"]` map it. |

The hook also removes `type: "infra"` and `type: "runtime"` attributes before Node resolves an import. **This matters even without infra**: Node 24 and 26 recurse until the stack overflows on any cycle of TypeScript imports that carry an attribute, so plain Node can't load such modules.

## Vitest

Vitest loads test files through Vite, so it needs the Vite plugin in place of the Node hook.

```ts [vitest.config.ts]
import { notationTesting } from "@notation/aws/testing/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [notationTesting()],
});
```

The plugin serves static imports and dynamic imports `with { type: "infra" }`, as the hook does. A dynamic import's specifier must be a string literal, since the plugin reads it from the source.

## Node's test runner

Plain Node loads the hook with `--import`. It needs Node 22.15 or later, for `module.registerHooks()`, and Node's TypeScript support.

```sh
node --import @notation/aws/testing/register --test runtime/checkout.test.ts
```

Any script that loads runtime modules needs the hook in the same way.
