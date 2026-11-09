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
- An authorizer's state key is its `id`, not a hash of its issuer and audience. Changing the issuer or audience updates the authorizer in place. Two authorizers on one API with the same issuer and audience are allowed when their IDs differ. In AWS, the authorizer is named after its `id`, or its `name`, with no prefix, because its API's name has the prefix already.
- An existing authorizer's state key changes from `<api>-jwt-authorizer-<hash>` to `<id>-authorizer`, so the next deploy replaces it. Queues, APIs and schedules keep their state keys if their new `id` is the old `name`. A FIFO queue whose old name ended in `.fifo` gets a new state key, because an `id` can't contain `.`.
