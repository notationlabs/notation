---
"@notation/aws": minor
"@notation/resource": minor
---

Resource groups now expose their key resources as typed fields: `ApiGroup.api`, `LambdaGroup.fn`, `RouteGroup.route` and `ScheduleGroup.rule`. `api()`, `lambda()`, `route()` and `schedule()` return these classes, and route and schedule handlers are typed as `LambdaGroup`.

`ResourceGroup.findResource` has been removed. Use the typed fields instead.

`ResourceGroup.addOnce` adds a resource unless the group already has one with the same ID, and returns the one the group holds. Use it for resources that bind two others, such as an API integration, which several call sites may create.

Two bugs are fixed:

- When several APIs target the same Lambda function, each API now gets its own integration and invoke permission. Previously, every API reused the first API's integration, and the other APIs had no permission to invoke the function.
- When several schedules target the same Lambda function, each schedule now gets its own invoke permission. Previously, only the first schedule got one, so the other schedules could not invoke the function.
