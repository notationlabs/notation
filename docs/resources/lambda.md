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
  id: "todos",
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

## IDs

Every Lambda function has an ID. It names the function and the resources that support it (`<id>`, `<id>-role`, `<id>-zip`, `<id>-policy`, `<id>-role-policy` and `<id>-log-group`), and keys them in state. Changing an ID replaces the function, so choose one that stays the same when you move or rename files.

In a `.fn.ts` file, set `id` in the `config` export. Each handler gets the ID `<id>-<handler>`, so with `id: "todos"` the `getTodos` handler becomes the function `todos-getTodos`. Compilation fails if `config` has no `id`, or if `<id>-<handler>` isn't name-safe.

When calling `lambda()` directly, pass `id`:

```ts [infra/lambda.ts]
import { lambda } from "@notation/aws/lambda";

export const external = lambda({
  id: "external-js",
  handler: "handler",
  code: { type: "file", path: "external/lambda.mjs" },
});
```

IDs must be name-safe: 1 to 59 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names, and 59 leaves room for the `-role` suffix in the 64-character IAM role name. `lambda()` only accepts string literals that follow this rule, and throws at runtime if it gets anything else. Two Lambda functions in one deployment can't share an ID. IDs that differ only in case, like `myFn` and `myfn`, count as the same, because IAM role names ignore case.

## Configuration

Lambda settings are configured via the `config` export in `.fn.ts` files. See [Lambda Config](lambda-config.md) for details.

```ts [runtime/user.fn.ts]
export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "user",
  memory: 256,
  timeout: 30,
};
```

## Inline policy

A Lambda group's `policy` is an inline policy on the function's role, named `<id>-role-policy`. Other code adds statements to it with `contribute`, and the statements from every contribution are joined into one policy document. For example, to let the `external` function from above send to an [SQS queue](sqs.md):

```ts [infra/lambda.ts]
external.policy.contribute({
  PolicyDocument: {
    Statement: [
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: orderQueue.arn },
    ],
  },
});
```

[`queue.consume`](sqs.md#queueconsumehandler) uses the same policy for the read permission it adds.

The group creates the policy resource only when code first reads `lambdaGroup.policy`. This matters because IAM rejects a policy with no statements, so a function that nothing contributes to must have no inline policy. A role's inline policies share a limit of 10,240 characters.

## Environment

A function's `Environment` is collected: any code can contribute to it, and the contributions are merged key by key. Two contributions that set one key to different values fail the plan, and the error names both contributors.

```ts [infra/lambda.ts]
external.fn.contribute({
  Environment: { Variables: { QUEUE_URL: orderQueue.url } },
});
```

A variable that waits on an undeployed output shows as unknown at its own key in a plan, and the other variables stay visible:

```
Environment.Variables.QUEUE_URL = (known after apply)
```

When the last contribution to `Environment` goes, the next deploy removes the function's variables.

## Runtime defaults

| Setting       | Default      |
| ------------- | ------------ |
| Runtime       | Node.js 18.x |
| Memory        | 128 MB       |
| Timeout       | 3 seconds    |
| Concurrency   | 1 (reserved) |
| Log retention | 30 days      |
