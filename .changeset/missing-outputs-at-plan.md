---
"@notation/resource": patch
"@notation/reconciler": patch
---

Plan treats a required output that is missing from a dependency's state record as unknown, as it does for a dependency that hasn't been created. A record written before an output was added to its resource type lacks the output. Before, plan read it as `undefined`, so a dependent's required param was missing, and plan and deploy failed before any change. Now the dependent's params that use the output are shown as unknown. Deploy reads the dependency again, fills in the output and then deploys the dependent.
