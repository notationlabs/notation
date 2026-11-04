# Compiler

The compiler turns a project into two kinds of output: an infra bundle, which builds the resource graph when it runs, and one bundle for each function that runtime code declares.

Source: `@notation/esbuild-plugins`, `@notation/cli` (`packages/cli/src/compile.ts`), `@notation/resource`

## The running example

This page uses the SQS example in `examples/sqs`. The entry is `infra/orders.ts`, and two runtime modules declare one function each.

::code-group

```ts [infra/orders.ts]
import { api, router } from "@notation/aws/api-gateway";
import { queue } from "@notation/aws/sqs";
import { createOrder } from "runtime/checkout.fn" with { type: "runtime" };
import {
  processOrders,
  processRefunds,
} from "runtime/orders.fn" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(processOrders, { batchSize: 5 });

export const refundQueue = queue({ name: "refunds" });
refundQueue.consume(processRefunds);

const ordersApi = router(api({ name: "orders-api" }));
ordersApi.post("/orders", createOrder);
```

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
      QueueUrl: orderQueue.url,
      MessageBody: req.body ?? "{}",
    }),
  );
  return json({ ok: true });
});
```

```ts [runtime/orders.fn.ts]
import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "orders", timeout: 5, memory: 64 });

export const processOrders = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("order", record.body);
});

export const processRefunds = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("refund", record.body);
});
```

::

The two modules import each other. `infra/orders.ts` needs `createOrder` to wire it to a route, and `checkout.fn.ts` needs `orderQueue` for its grant and for the queue's URL.

## Runtime modules

**A runtime module is a file that infra imports `with { type: "runtime" }`.** In the example, the runtime modules are `runtime/checkout.fn.ts` and `runtime/orders.fn.ts`. The compiler finds them by following infra's imports, so a file that no infra module imports this way is never a runtime module. A file that infra imports this way is a runtime module even if it matches none of the `runtimeModules` globs.

The `runtimeModules` globs in `notation.config.ts` (default `**/*.fn.ts`) are a guard. If infra imports a file without the attribute, and the file matches a glob or another infra module imports it with the attribute, the infra build fails:

```
runtime/checkout.fn.ts is a runtime module, so infra must import it with { type: "runtime" }.
```

A runtime module declares its functions by calling `lambda()`. A module that still exports `resource` from the earlier design fails the build with a message that explains how to move to `lambda()`.

## Build order

`notation compile` runs these steps. Steps 2 to 4 are `compile()` in `packages/cli/src/compile.ts`.

1. **Write `notation-env.d.ts`**, the declarations that type both sides of each attributed import. See [`notation types`](../cli/types.md).
2. **Bundle the infra phase** to `dist/infra/<entry>.mjs`, such as `dist/infra/orders.mjs`. This is `compileInfra`.
3. **Evaluate the infra bundle** in a child process. `evaluateFunctions` collects the resource graph and returns `graph.runtimeFunctions`: the functions that `lambda()` declared, each with its ID, bundle path and handlers.
4. **Bundle each function** to `dist/functions/<id>/index.mjs`, and list the values it reads from infra in `reads.json` next to it. This is `compileFunctions`.
5. **Deliver the reads.** Plan and deploy evaluate the infra bundle again, and give each function the values listed in its `reads.json`.

The function bundles come after evaluation, because which handlers belong to which function is only known once `lambda()` has run. A child process does the evaluation, so the infra bundle and its module cache don't stay in the CLI's process.

## The infra phase

The infra phase is the infra bundle, evaluated. `infraPlugin` (`plugins/infra-plugin.ts`) builds it so that **runtime modules run after all of infra**. This removes the import cycle above: when `checkout.fn.ts` runs, `orderQueue` already exists. It also means the plan doesn't depend on the order in which infra modules load.

The plugin's build runs in four stages.

### 1. The scan

Which runtime modules exist is only known once infra's imports have been resolved. So each build starts with a scan: a build of the same infra that writes nothing, and only records each file imported `with { type: "runtime" }`.

Runtime code can import an infra module `with { type: "infra" }` that no other infra module imports, and that infra module can import more runtime modules. So after the scan, the plugin makes the stripped copies, and if they import an infra module that the scan didn't build, it scans again with that module as an extra entry. It repeats this until every such infra module has been scanned.

### 2. Stand-ins

In the infra bundle, a `type: "runtime"` import resolves to a stand-in module instead of the runtime module. `createStandInModule` generates it from the runtime module's export names, which the plugin reads from the source, following `export *`. The stand-in module for `orders.fn.ts` is:

```ts [generated stand-in module]
import { createStandIn } from "@notation/resource";
const __notationStandIn0 = createStandIn("runtime/orders.fn.ts", "processOrders");
export { __notationStandIn0 as processOrders };
const __notationStandIn1 = createStandIn("runtime/orders.fn.ts", "processRefunds");
export { __notationStandIn1 as processRefunds };
```

None of the runtime module's code runs here. A stand-in is a proxy:

- Infra APIs that take a handler, such as `route()` and `consume()`, accept it. They record it, and apply their wiring when evaluation ends, through `onEvaluationEnd`.
- `standIn.function` is a lazy proxy of the function: the handler's function, or the export itself for an exported `lambda()` result. Infra can pass it to an infra API, which resolves it after linking.
- Reading any other property, such as `checkoutFn.arn` on an exported `lambda()` result, gives a lazy proxy of that property. So does a read or a call on a lazy proxy, such as `createOrder.function.grantInvoke()`. Resources and infra APIs resolve the proxies after linking.
- Reading `id`, or turning a stand-in or a lazy proxy into a string, fails while infra is being evaluated: `createOrder.function isn't known yet: infra read its id while infra was being evaluated …`.

### 3. The generated entry

The bundle's entry point is not `infra/orders.ts` itself. `createInfraEntry` generates an entry that imports infra first and the runtime modules last. ES modules evaluate imports in order, so infra has fully loaded before any runtime module runs. Simplified:

```ts [generated infra entry]
export * from "infra/orders.ts";
import { linkRuntimeModules } from "@notation/resource";
import * as __notationInfra0 from "infra/orders.ts";
import * as __notationStandIns0 from "notation-standin:runtime/checkout.fn.ts" with { type: "runtime" };
import * as __notationRuntime0 from "notation-stripped:runtime/checkout.fn.ts";
import * as __notationStandIns1 from "notation-standin:runtime/orders.fn.ts" with { type: "runtime" };
import * as __notationRuntime1 from "notation-stripped:runtime/orders.fn.ts";

linkRuntimeModules([
  { module: "runtime/checkout.fn.ts", standIns: __notationStandIns0, exports: __notationRuntime0 },
  { module: "runtime/orders.fn.ts", standIns: __notationStandIns1, exports: __notationRuntime1 },
], {
  "infra/orders": __notationInfra0,
});
```

- The `notation-stripped:` imports load the [stripped copies](#stripped-copies) of the runtime modules, not the modules themselves.
- The entry imports each stand-in module with the same attribute that infra uses. esbuild keys modules by their attributes too, so the entry gets the same stand-ins that infra holds.
- The second argument lists each infra module that runtime code imports `with { type: "infra" }`, keyed by its path from the project root without its extension. Reads are resolved against these exports.

### 4. Linking

`linkRuntimeModules` (`packages/resource/src/runtime-link.ts`) is the last statement of the entry. It:

1. Names each handler that a stripped copy exports after its export, such as `createOrder`.
2. Links each stand-in to the export it names. From now on, a stand-in reads through to the handler.
3. Fails on a handler that no runtime module exports, naming its `handle` call.
4. Gives each declared function its handlers, and adds it to `graph.runtimeFunctions`, sorted by ID. A function with no handlers fails, and so do two handlers of one function with the same export name.
5. Delivers reads, when the graph is collected for plan or deploy. See [Delivering reads](#delivering-reads).

The wiring that `route()` and `consume()` deferred runs after this, when evaluation ends. At that point a stand-in resolves to its handler, and the API checks the handler's kind: `consume()` takes only SQS handlers, for example.

## Stripped copies

The infra phase doesn't run a runtime module as written. In `checkout.fn.ts`, `new SQSClient()` and the handler's body only make sense in the function. `stripRuntimeModules` (`infra-phase/strip.ts`) makes a copy of each runtime module that keeps only what declaring its functions needs. Per top-level statement, the copy keeps:

1. **Calls to `type: "infra"` imports** made while the module body runs, such as `lambda(...)`.
2. **Declarations derived from those calls**, and exports of them. `handle` comes from `lambda()`, and `createOrder` comes from `handle`, so both are kept. This carries across files: `import { handle } from "./fn"` counts.
3. **Everything a kept statement references**: declarations, imports, and what kept function bodies reference.
4. **Statements that update a kept binding**, such as `memory *= 2`.

A binding is also derived when its initializer calls infra outside a function body, as `cond ? lambda(a) : lambda(b)` does.

Calls of `handle.<kind>(...)`, where `handle` is the `handle` property of a factory call's result, get an inert placeholder in place of their arguments, so handler bodies never run. This follows the binding through destructuring, aliases and imports, as in `const { handle: { apiRequest } } = lambda(...)` or `fn.handle.apiRequest(...)`. Other calls on derived bindings, such as `queue({ name: "x" }).grant([...])` in the settings, run as written. The stripped copy of `checkout.fn.ts`, as it appears in `dist/infra/orders.mjs`:

```js [stripped copy of runtime/checkout.fn.ts]
import { lambda } from "@notation/aws/lambda";
var __notationInert = () => {
  throw new Error("A handler doesn't run in the infra phase.");
};
var { handle } = lambda({
  id: "checkout",
  timeout: 5,
  grants: [orderQueue.grant(["SendMessage"])],
});
var createOrder = handle.apiRequest(__notationInert);
```

The SDK import, `new SQSClient()` and the handler's body are gone. `orderQueue` is the real queue, because a `type: "infra"` import in a stripped copy resolves to the infra module itself.

A local module that a copy imports is stripped in the same way, starting from the names the copy imports. Its other exports become `undefined`. Only scripts (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) are stripped. A copy imports other files, such as `config.json`, from the file itself.

**Settings lose effects they don't reference.** The rules keep only what the settings reference, so an effect that reaches the settings some other way is removed without an error:

- A side-effect import, such as `import "./env-setup"` setting a global that the settings read, is removed, so the setting is `undefined`.
- A mutation through a call, such as `bump()` changing a counter that the settings read, is removed.

A class that the settings use is kept whole, so its static blocks run at plan. Settings that do I/O, such as fetching a value, do it at plan.

## Function bundles

`compileFunctions` bundles every function in one esbuild build, with one entry point per function. Each bundle includes its dependencies, unlike the infra bundle, which leaves packages external.

### The function entry

`createFunctionEntry` generates each entry from the function's handlers:

```ts [generated entry of the checkout function]
import { createDispatcher } from "@notation/aws/lambda.fn";
import { createOrder as __notationHandler0 } from "/path/to/runtime/checkout.fn.ts";
export const handler = createDispatcher({
  "createOrder": __notationHandler0,
});
```

The dispatcher comes from the service's runtime package, `@notation/<platform>/<service>.fn`. The entry imports it first, so it is set up before any handler's module runs. Lambda calls `index.handler`, and `createDispatcher` sends each event to one of the function's handlers. See [Dispatch](../resources/lambda.md#dispatch).

A function's bundle holds only its own handlers. If one runtime module calls `lambda()` twice, each function dispatches only to the handlers that its own `handle` made.

### Rewriting infra imports

`runtimePlugin` (`plugins/runtime-plugin.ts`) rewrites each runtime module that imports infra `with { type: "infra" }`, using `rewriteRuntimeModule` (`runtime-bundle/rewrite.ts`). The rewrite makes sure that the bundle keeps only runtime code:

| In runtime code | In the bundle |
| --- | --- |
| `import { lambda } from "@notation/aws/lambda" with { type: "infra" }` | `import { lambda } from "@notation/aws/lambda.fn"`: the provider's runtime half |
| `lambda({ id: "checkout", timeout: 5, grants: [...] })` | `lambda()`: the settings are removed |
| A top-level declaration that only the settings use | Removed |
| A top-level statement that only updates such a declaration, such as `Object.assign(settings, …)` | Removed |
| A call to infra made while the module body runs, outside the settings, such as `export const grants = [orderQueue.grant([…])]` | A pure placeholder call, which tree-shaking removes if only the settings use its result |
| `orderQueue.url` | `/* @__PURE__ */ read("infra/orders#orderQueue", ["url"])` |
| `orderQueue` used as a value | `read("infra/orders#orderQueue", [])`: every data property of the binding, as one object |
| `import { orderQueue } from "infra/orders" with { type: "infra" }` | Removed, and `read` is imported from `@notation/resource/outputs` |

The runtime half of `lambda()` returns `{ handle }`, and each `handle.<kind>(fn)` returns `fn`, marked with its kind. So the handler is the plain function in the bundle.

The rewrite fails the build on code that it can't turn into a read:

| Code | Error |
| --- | --- |
| `orderQueue.grant(["SendMessage"])` in a function body | `orderQueue.grant() calls infra from runtime code. Infra functions only run in the infra phase: call them in the settings of lambda(), …` |
| A placeholder call that is left in the bundle after tree-shaking, such as `console.log(orderQueue.grant([…]))` at the top level | `orderQueue.grant() calls infra from runtime code, and the function's bundle keeps the call. …` |
| `orderQueue.url = "…"` | `Runtime code can't change orderQueue.url, which it reads from infra.` |
| `import * as orders from "infra/orders" with { type: "infra" }`, then `orders` used as a value | `orders is a namespace import of infra, which runtime code can't use as a value. …` |
| `export { orderQueue }` | `Runtime code can't re-export orderQueue, which it imports from infra.` |

A method call on a value that runtime code reads, such as `orderQueue.url.startsWith("https:")`, is allowed. The rewrite reads `orderQueue.url`, and the call runs on the string.

The placeholder calls let settings take grants from an export, or from a helper module such as `runtime/config.ts` that the runtime module imports. The function's entry imports only the handlers, so tree-shaking removes the export when nothing else uses it. A statement removed because it only updates the settings is removed with all of its effects, as in `settings.memory = compute()`.

The plugin also fails when runtime code imports an infra package, such as `@notation/aws/sqs`, without the attribute, because the bundle would then include infra. When the package comes in through a local infra module, the error names the runtime module that imports the infra module, and the chain of imports:

```
runtime/checkout.ts imports infra/orders.ts without { type: "infra" }, and infra/orders.ts imports @notation/aws/sqs, so the bundle of runtime code would include infra (runtime/checkout.ts → infra/orders.ts → @notation/aws/sqs). …
```

A `type: "runtime"` import in runtime code fails too.

## Delivering reads

A function receives the values it reads from infra through its `NOTATION_RUNTIME` environment variable. Delivery has four parts.

1. **Listing reads.** The rewrite marks each `read` call pure, so esbuild removes reads that tree-shaking drops. After each build, `findReads` lists the calls in each output file that have the shape of a read, whatever their spacing and callee name, and the plugin keeps the ones that a rewrite made. The CLI writes them to `reads.json` next to the bundle:

   ```json [dist/functions/checkout/reads.json]
   {
     "reads": ["infra/orders#orderQueue.url"]
   }
   ```

   Only the reads in the finished bundle count. Otherwise dead code would deliver extra values, or fail plan on values the function never reads.

   `read` comes from a small module that wraps the one in `@notation/resource/outputs`. If the metafile shows that a bundle keeps the wrapper, but no reads are found in it, the build fails.

2. **Resolving values.** Plan and deploy collect the graph with `runtimeReads`, which reads each function's `reads.json`. `linkRuntimeModules` then calls `resolveReads`, which looks each key up in the infra module's exports. `infra/orders#orderQueue.url` resolves to the queue's `url`, an output value. A read fails at plan if the value is a function, is `undefined`, or is not an output value or data.

3. **Storing values.** `lambda()` passes a `deliver` callback to `declareRuntimeFunction`. It contributes the values to the function's environment as `Environment.Runtime.outputs`, next to the dispatch map. Output values in it resolve at deploy, as in any other config.

4. **Reading values.** The function's dispatcher module, `@notation/aws/lambda.fn`, calls `addOutputSource` with a source that decodes `NOTATION_RUNTIME`. The first `read()` in the function loads the source into the store of `@notation/resource/outputs`, and each `read()` returns its value from there.

A read of a whole binding, such as `orderQueue` used as a value, delivers the binding's data properties as one object, and reads of its paths are then served from that object.

## Resource graph construction

Plan, deploy, destroy and viz build the resource graph by importing the infra bundle inside `collectResourceGraph`:

```ts [packages/core/src/orchestrator/graph.ts]
return collectResourceGraph(
  async () => {
    await import(`${outFilePath}?${Date.now()}`);
  },
  { scope, declarationChecks: opts.declarationChecks, runtimeReads: … },
);
```

While the bundle is imported, calls such as `queue({ name: "orders" })` and `lambda({ id: "checkout", … })` add their resources to the graph.

`scope` holds the app and the stage of the deployment. Resource constructors call `scopedPhysicalName` from `@notation/resource`, which reads `scope` and returns the name `<app>--<stage>--<id>`. `notation viz` deploys nothing, so it passes no scope, and the names in its graph are the bare IDs.

The reconciler uses the resulting `{ resources, resourceGroups }` object to plan deployments.

## Watch mode

In watch mode (`notation watch`), esbuild rebuilds the infra bundle in `context.watch()` mode. After each infra build without errors, the CLI evaluates the bundle again and compares the functions it declares, with their handlers, against the previous list. When the list changes, the CLI stops the function builds and starts new ones for the new list. So adding a `lambda()` call or a handler restarts the function builds, and a removed function is no longer built; the reconciler deletes its resources. The function builds also run in watch mode, so a change to a handler's code rebuilds its bundle.

The infra build watches the runtime modules and the files their stripped copies read, so a change to a function's settings rebuilds the infra bundle. A change to the config file makes `notation watch` exit, so you restart it with the new config.
