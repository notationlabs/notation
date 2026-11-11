---
"@notation/resource": minor
"@notation/aws": patch
---

`perCollection(key, create)` keeps one value for each resource graph that is being collected, so that two graphs collected in one process don't see each other's declarations. It returns `undefined` when no graph is being collected. `@notation/aws` now keeps its claimed AWS names and the default event bus with it. `@notation/cloudflare` uses it too.
