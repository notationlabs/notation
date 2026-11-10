---
"@notation/aws": minor
---

Every resource that you declare takes a required `id`, as `$lambda` and `lambda()` already do. The `id` keys the resource in state, and Notation builds the AWS name from it.

```ts
const ordersQueue = queue({ id: "orders", schema: Order });
const userApi = api({ id: "user-api" });
const userAuth = jwtAuthorizer({
  id: "user-auth",
  api: userApi,
  issuer,
  audience,
});
schedule({ id: "nightly", schedule: rate(1, "day"), target: () => lambda });
```

- `queue()`, `api()`, `schedule()` and `eventBridge.defineSchedule()` take `id` in place of `name`. `jwtAuthorizer()` takes a new required `id`.
- An `id` has 1 to 64 letters, digits, hyphens or underscores, and must be a string literal. TypeScript reports an `id` that breaks the rule, and the function throws on one when infra runs. `NameSafe` and `isNameSafe` check the rule. `LAMBDA_ID_MAX_LENGTH` is renamed `ID_MAX_LENGTH`.
- A queue, an API, an authorizer, a schedule and a Lambda function take an optional `name`, which replaces the `id` in the AWS name. The `<app>--<stage>--` prefix stays, so `queue({ id: "orders", name: "order-events" })` is named `<app>--<stage>--order-events`. A function's `name` sets only the function's name, and its role keeps the name from the `id`. A `name` has the same characters as an `id`.
- A FIFO queue no longer needs `.fifo` in its name. Notation adds `.fifo` to the AWS name of a queue with `fifo: true`.
- An authorizer's state key is its API's `id` and its own `id`, such as `api-authorizer:todo-api:user-auth`, not a hash of its issuer and audience. Two APIs can each have an authorizer with the same `id`. Changing the issuer or audience updates the authorizer in place. Two authorizers on one API with the same issuer and audience are allowed when their IDs differ. In AWS, the authorizer is named after its `id`, or its `name`, with no prefix, because its API's name has the prefix already. The old AWS name was `${apiId}_jwt_<hash>`, and the new one is `name ?? id`, so the next deploy replaces each existing authorizer.
- Every state key changes. A resource's state key is now a type prefix and the IDs that the resource belongs to, joined with `:`, such as `lambda:orders`, `lambda:orders:role`, `sqs-queue:orders`, `sqs-mapping:orders:process-orders`, `api:todo-api`, `api-route:todo-api:GET /todos`, `api-integration:todo-api:todos`, `api-authorizer:todo-api:user-auth` and `eventbridge-rule:nightly`. Before, keys such as `orders-queue` and `todo-api-GET-/todos` joined IDs with `-`, so an API and a Lambda with the same `id` got the same key, and queue `a` with Lambda `b-c` got the same mapping key as queue `a-b` with Lambda `c`. An `id` can't contain `:`, so keys can no longer collide. State from an earlier version doesn't match the new keys: destroy a deployment with the earlier version before you upgrade, or expect the next deploy to try to create every resource again.
- Two Lambda functions, two queues or two EventBridge rules in one deployment can't have the same AWS name, and two authorizers of one API can't either. For example, `$lambda({ id: "a", name: "b" })` and `$lambda({ id: "b" })` both name a function `<app>--<stage>--b`. Infra throws when it runs, and the error names both declarations. An invalid `name` or a duplicate `id` of a `$lambda` is reported as coming from `$lambda`, not `lambda()`.
- A Lambda permission's `StatementId` is `apigateway-<api id>` for an API, and `events-<rule name>` for an EventBridge rule. Before, a function routed from two APIs, or on two schedules, got two statements with the same ID, and `AddPermission` failed.
