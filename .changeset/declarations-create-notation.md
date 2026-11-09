---
"create-notation": minor
---

The starter's runtime module declares its Lambda with `$lambda` and exports `handler`. The starter's infra routes `/todos` to `() => lambda`. The declaration has `event: () => apiGateway.schema(null)`, as its requests have no body.
