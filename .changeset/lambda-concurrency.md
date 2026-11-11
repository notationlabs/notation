---
"@notation/aws": minor
---

Lambda functions no longer reserve concurrency by default. `$lambda()` and `lambda()` take a `concurrency` option, which adds a `lambda.LambdaFunctionConcurrency` resource that sets the function's reserved concurrency. Existing functions need no action. The deploy role needs `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency` and `lambda:GetFunctionConcurrency` only for functions that set `concurrency`.
