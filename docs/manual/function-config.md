# Lambda Config

Export a `config` object from any `.fn.ts` file to customize Lambda function settings.

## Type

```ts [@notation/aws/lambda.fn.ts]
type LambdaConfig = {
  service: "aws/lambda";
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
  memory: 256,
  timeout: 30,
};
```

## Defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 18.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
