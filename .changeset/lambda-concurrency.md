---
"@notation/aws": minor
---

Lambda functions no longer reserve concurrency by default. `$lambda()` and `lambda()` take a `concurrency` option, which adds a `lambda.LambdaFunctionConcurrency` resource that sets the function's reserved concurrency. Versions after `@notation/aws.iac` 0.5.0 applied no reservation, so their functions need no action. A function first deployed by 0.5.0 or earlier keeps a reserved concurrency of 1 until you remove it with `aws lambda delete-function-concurrency`. The deploy role needs `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency` and `lambda:GetFunctionConcurrency` only for functions that set `concurrency`.
