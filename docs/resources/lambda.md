# Lambda

Lambda functions are created implicitly when you wire `.fn.ts` handlers to infrastructure.

## Implicit creation

When you import from a `.fn.ts` file in your infrastructure code, the compiler transforms each handler export into a Lambda resource. A single import generates:

- **Lambda function** with bundled handler code
- **IAM execution role** with least-privilege permissions
- **CloudWatch log group** with 30-day retention
- **Deterministic zip package** of the handler code

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getTodos } from "runtime/todos.fn";

const myApi = api({ name: "todo-api" });
const myRouter = router(myApi);

myRouter.get("/todos", getTodos);
```

### The transformation

The [function-infra-plugin](../internals/compiler.md) intercepts `.fn.ts` imports and replaces handler exports with Lambda resource declarations:

::code-group

```ts [runtime/todos.fn.ts]
import type { LambdaConfig } from "@notation/aws/lambda.fn";
import { handle, json } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json([{ id: 1, text: "Build with Notation" }]);
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  timeout: 5,
  memory: 64,
};
```

```ts [dist/todos.fn.ts]
export const getTodos = async () => {
  return {
    body: JSON.stringify({ id: 1, text: "Build with Notation" }),
    statusCode: 200,
  };
};
```

::

The plugin strips runtime-only code (imports, side effects) that would be unsafe in an infrastructure context, preserves the `config` object, and emits a `lambda()` call for each exported handler. Reserved exports like `config` and `preload` are excluded from the transform.

## Configuration

Lambda settings are configured via the `config` export in `.fn.ts` files. See [Lambda Config](lambda-config.md) for details.

```ts [runtime/user.fn.ts]
export const config: LambdaConfig = {
  service: "aws/lambda",
  memory: 256,
  timeout: 30,
};
```

## Runtime defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 18.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
