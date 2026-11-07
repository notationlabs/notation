---
"@notation/resource": patch
---

Loading a second copy of `@notation/resource` now throws, with the paths of both copies. Each copy keeps its own resource graph, so resources made through the second copy were missing from the graph that plan and deploy read. Install one version, for example with `npm dedupe`.
