# EventBridge bus + rules resource

**Idea:** Add an EventBridge resource family so users can declare an event bus and rules
that target lambdas — the eventing backbone that `@notation/aws` currently lacks.

Minimal shape (relative to main):

- `packages/aws.iac/src/resources/event-bridge/` — `bus.ts`, `rule.ts`, `index.ts`
- `packages/aws/src/event-bridge/` — `event-bus.ts`, `index.ts` (user-facing builders)
- A rule targets a lambda; needs create-before-delete / destroy-before-create handling
  to avoid target conflicts on update (a recurring pain point in the old spikes).

**Source branches (archaeology):** `add-event-bridge-resource-gordon`, `event-bridge`,
`gordon-event-bus`, `stateful-deploy`. All ~2023-12 and far behind; treat as reference only.
