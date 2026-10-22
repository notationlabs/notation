# Lambda Config

Export a `config` object from any `.fn.ts` file to customize Lambda function settings.

## Type

```ts [@notation/aws/lambda.fn.ts]
type LambdaConfig = {
  service: "aws/lambda";
  id: string;
  memory?: number;
  timeout?: number;
};
```

## Usage

```ts [runtime/heavy-task.fn.ts]
import type { LambdaConfig } from "@notation/aws/lambda.fn";
import { handle } from "@notation/aws/lambda.fn";

export const processData = handle.apiRequest((event) => {
  // heavy processing
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "heavy-task",
  memory: 256,
  timeout: 30,
};
```

## `id`

`id` is required. Each handler in the file becomes a Lambda function with the ID `<id>-<handler>`; in the example above, `heavy-task-processData`. The ID names the function, its IAM role and its log group, and keys them in state, so changing it replaces the functions. Use letters, digits, hyphens and underscores, and keep `<id>-<handler>` to 59 characters or fewer. See [Lambda IDs](../resources/lambda.md#ids).

## Defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 18.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
