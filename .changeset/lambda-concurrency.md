---
"@notation/aws": minor
---

Lambda functions no longer reserve concurrency by default. `$lambda()` and `lambda()` take a `concurrency` option, which sets the function's reserved concurrency. Without it, the function uses the account's unreserved concurrency.

```ts
export const lambda = $lambda({
  id: "orders",
  concurrency: 10,
});
```

- The default of `ReservedConcurrentExecutions: 1` is removed. The value was never sent to AWS, because `CreateFunction` and `UpdateFunctionConfiguration` have no concurrency field, so deployed functions have no reservation to remove. The next deploy updates each function's recorded params.
- `LambdaFunction` sets `ReservedConcurrentExecutions` with `PutFunctionConcurrency` after it creates the function, and on update. When the param is removed, the update calls `DeleteFunctionConcurrency`.
- `ReservedConcurrentExecutions` is optional, and must be a whole number of 0 or more.
