# Compiler

The compilation pipeline uses esbuild with custom plugins to produce deployable infrastructure and runtime bundles.

Source: `@notation/esbuild-plugins`, `@notation/core`

## Two-pass compilation

Notation compiles the project in two passes:

1. **Infrastructure pass** – bundles the infra entry point with the `function-infra-plugin`, producing the resource graph.
2. **Function pass** – bundles each `.fn.ts` file separately as a Node.js Lambda handler.

The infra pass determines what infastructure resources should be provisioned; the function produces the code artefacts that run on them.

## The function-infra-plugin

The `function-infra-plugin` is an esbuild plugin that intercepts `.fn.ts` imports during the infrastructure build and replaces runtime handler code with infrastructure declarations.

### The transformation

::code-group

```ts [runtime/todos.fn.ts]
import { handle, json } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json([{ id: 1, text: "Learn Notation" }]);
});

export const createTodo = handle.apiRequest(async (req) => {
  const body = req.json();
  return json({ id: 2, text: body.text });
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  timeout: 5,
  memory: 64,
};
```

```ts [dist/todos.fn.ts]
import { lambda } from "@notation/aws/lambda";

export const getTodos = lambda({
  handler: "getTodos",
  timeout: 5,
  memory: 64,
});

export const createTodo = lambda({
  handler: "createTodo",
  timeout: 5,
  memory: 64,
});
```

::

### How it works

1. The plugin matches files with `.fn` in the path
2. Parses the source to extract the `config` export and all named exports
3. Reads `config.service` to determine the platform and service (e.g., `"aws/lambda"`)
4. Generates infrastructure code that imports the resource constructor and creates a resource for each export
5. Reserved names (`preload`, `config`) are skipped

Each named export in a `.fn.ts` file becomes a Lambda function (or other serverless resource). The same file defines both the runtime behaviour and the infrastructure required to run it.

## Resource graph construction

After compilation, the resource graph is built by dynamically importing the compiled infrastructure module:

```ts [packages/core/src/orchestrator/graph.ts]
return collectResourceGraph(() => import(outFilePath));
```

While the compiled entry point is imported, calls such as `lambda({ ... })` add the Lambda function and its associated resources (IAM role, log group, zip package) to the graph.

The reconciler uses the resulting `{ resources, resourceGroups }` object to plan deployments.

## Watch mode compilation

In watch mode (`notation watch`), esbuild runs in `context.watch()` mode for both passes. Changes to source files trigger incremental rebuilds.

The CLI also watches for structural changes to the project:

- **New `.fn.ts` files** – the function compiler is rebuilt to include them
- **Deleted `.fn.ts` files** – removed from the function compiler; orphaned resources are cleaned up by the reconciler
- **Config changes** – trigger a re-evaluation of the infrastructure graph

Together this gives you a live development loop: save a file, and Notation recompiles, re-evaluates the graph, and deploys the diff.
