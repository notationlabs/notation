# Lambda Resource

A runtime module exports `resource` to say what it deploys as. For a Lambda function, `resource` has the type `LambdaResource`. See [Runtime modules](./file-conventions.md#runtime-modules) for how Notation finds runtime modules.

## Type

```ts [@notation/aws/lambda.fn]
type LambdaResource = {
  service: "aws/lambda";
  id: string;
  timeout?: number; // seconds
  memory?: number; // megabytes
  runtime?: string; // such as "nodejs22.x"
};
```

## Usage

```ts [runtime/reports.fn.ts]
import { handle, type LambdaResource } from "@notation/aws/lambda.fn";

export const buildReport = handle.apiRequest((event) => {
  // heavy processing
});

export const emailReport = handle.eventBridgeScheduledEvent((event) => {
  // send the latest report
});

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "reports",
  memory: 256,
  timeout: 30,
};
```

The module deploys as one Lambda function with the ID `reports`. Both `buildReport` and `emailReport` run in this function, with 256 MB of memory and a 30-second timeout.

**The settings apply to every handler in the module.** If one handler needs more memory or a longer timeout than the others, move that handler to its own runtime module.

## Literal values

The compiler reads `resource` from the source text, and never runs the module. So `resource` must be an object literal, and its values must be literals: strings, numbers, booleans, `null`, arrays and objects. A value such as `timeout: DEFAULT_TIMEOUT` fails the build. `as` and `satisfies` are allowed:

```ts
export const resource = {
  service: "aws/lambda",
  id: "reports",
} satisfies LambdaResource;
```

## `id`

`id` is required. It names the function, its IAM role and its log group, and keys them in state. The ID doesn't depend on the module's path, so you can move or rename the module and keep its function. Changing the ID replaces the function.

Use 1 to 64 letters, digits, hyphens and underscores. Two runtime modules in one deployment can't share an ID. See [Lambda IDs](../resources/lambda.md#ids).

The compiler checks the ID, and fails the build with an error that names the module. Your editor doesn't check the ID in `resource`.

## Defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 22.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
