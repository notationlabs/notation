---
"@notation/resource": patch
"@notation/aws.iac": patch
"@notation/core": patch
---

`diffParams` now puts each changed param in `patch` whole, rather than as a nested diff. Changing one Lambda environment variable no longer drops the others, removing all of them now clears them, and an EventBridge rule update no longer sends a rule with no name or targets keyed by index. `@notation/core` drops its unused `deep-object-diff` dependency.
