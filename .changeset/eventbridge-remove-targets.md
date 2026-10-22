---
"@notation/aws.iac": patch
---

Updating an EventBridge rule now removes targets that are no longer in config. Previously a removed target stayed attached to the rule in AWS and kept receiving events.
