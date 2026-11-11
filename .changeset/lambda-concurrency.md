---
"@notation/aws": minor
---

Lambda functions no longer reserve concurrency by default. `$lambda()` and `lambda()` take a `concurrency` option, which adds a `lambda.LambdaFunctionConcurrency` resource that sets the function's reserved concurrency. Functions deployed by versions since `@notation/aws.iac` 0.10.0 had no reservation applied and need no action. A function first deployed by an earlier version keeps a reserved concurrency of 1 until you remove it with `aws lambda delete-function-concurrency`. The deploy role needs `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency` and `lambda:GetFunctionConcurrency` only for functions that set `concurrency`.
