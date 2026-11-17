# Compiler Marks

Provider and framework authors use JSDoc `@declaration` and `@resource` marks to build colocated `$function`-style APIs where one module defines both infrastructure and runtime code. `@notation/build` reads these marks from exported functions in your package's published ESM output – without a compiler plugin – to split deploy-time and runtime builds and enforce module boundaries.

## Package entrypoints

To share one TypeScript API while shipping separate deploy-time and runtime implementations, add a `"notation-runtime"` export condition before `"import"` in `package.json`:

```json [package.json]
{
  "name": "@acme/jobs",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "notation-runtime": "./dist/runtime.js",
      "import": "./dist/index.js"
    }
  }
}
```

Deploy-time evaluation resolves `"import"` (`dist/index.js`, where `@notation/build` reads your JSDoc marks), while runtime bundles resolve `"notation-runtime"` (`dist/runtime.js`) with zero deployment dependencies. Preserve JSDoc comments in your build output, and pass `--conditions=notation-runtime` when testing runtime helpers directly in Node.

## Deploy-time declarations

In `src/index.ts`, annotate your exported declaration builder with `@declaration` and combine `@notation/resource` evaluation hooks to discover the caller's compiled module path and register resources once all modules load:

```ts [src/index.ts]
import { getActiveResourceCollection, getDeclaredIn, onEvaluationEnd } from "@notation/resource";

export type JobConfig<Env extends Record<string, string>> = {
  id: string;
  env?: () => Env;
  url?: string;
};

/**
 * Declares a background job function.
 * @declaration shared: id, env; keys: env; entry: run; outputs: url
 */
export function $job<Env extends Record<string, string>>(config: JobConfig<Env>) {
  const declaration = {
    id: config.id,
    url: "" as string,
    env: () => {
      throw new Error(`$job({ id: ${JSON.stringify(config.id)} }).env() can only be called at runtime.`);
    },
  };
  if (getActiveResourceCollection()) {
    onEvaluationEnd(() => {
      const declared = getDeclaredIn(declaration);
      if (declared) {
        // Register resources using `declared.path` and `declared.binding`.
      }
    });
  }
  return declaration;
}
```

Each piece of this pattern serves a specific build boundary:

- **`shared: id, env; keys: env`** – Keeps `id` and `env` in both builds while rewriting `env()` in the runtime bundle to preserve keys and drop deploy-time values; any unlisted option is stripped from runtime bundles.
- **`entry: run; outputs: url`** – Tells `@notation/build` to bundle the module's `run` export and reject static reads of `job.url` inside runtime code.
- **`onEvaluationEnd` + `getDeclaredIn`** – Defers resource registration until all infra and runtime modules finish loading so circular imports resolve cleanly and `declared.path` holds the compiled module path relative to the project root.

## Runtime declarations

In `src/runtime.ts`, implement the `"notation-runtime"` build of `$job` so `env()` reads `process.env` and any listed `outputs` (`url`) define non-enumerable throwing getters against indirect reads at runtime:

::code-group

```ts [src/runtime.ts]
import type { JobConfig } from "./index";

export function $job<Env extends Record<string, string>>(config: JobConfig<Env>) {
  const declaration = {
    id: config.id,
    env: () => Object.fromEntries(Object.keys(config.env?.() ?? {}).map((k) => [k, process.env[k]])) as Env,
  };
  return Object.defineProperty(declaration, "url", {
    enumerable: false,
    get() {
      throw new Error(`Runtime code cannot read $job({ id: ${JSON.stringify(config.id)} }).url directly; bind it in env.`);
    },
  });
}
```

```ts [runtime/process-order.ts]
import { $job } from "@acme/jobs";

export const processOrder = $job({
  id: "process-order",
  env: () => ({ QUEUE_MODE: "async" }),
});

export const run = async () => {
  const { QUEUE_MODE } = processOrder.env();
  return { mode: QUEUE_MODE };
};
```

::

Keep the throwing `env()` in `src/index.ts` and the runtime `env()` in `src/runtime.ts` aligned so accidental runtime calls in infra code fail fast with clear remediation instructions.

## Resource projections

Annotate infrastructure helpers and constructors in your package with `@resource` so `@notation/build` knows what runtime bundles are allowed to reference:

```ts [src/resources.ts]
/** @resource runtime: schema */
export function jobQueue<S>(config: { id: string; schema: S }) {
  // Returns a queue handle; runtime bundles keep only `{ schema }`.
  return config;
}

/** @resource runtime: */
export function jobRouter(config: { id: string }) {
  // Returns a router handle; runtime bundles project this to `{}`.
  return config;
}

/** @resource */
export function jobSchedule(config: { id: string; cron: string }) {
  // Deploy-only resource; passing it into a runtime bundle fails the build.
  return config;
}
```

`@notation/build` detects `@resource` marks across function calls, `new` expressions, and tagged templates. Because `@notation/resource` marks `` text`...` `` and `all()` with `@resource`, calling them inside runtime handler code fails the runtime build just like calling a resource constructor.
