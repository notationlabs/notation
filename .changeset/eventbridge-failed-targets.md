---
"@notation/aws.iac": patch
---

Creating, updating or deleting an EventBridge rule now fails when AWS rejects any of its target changes, listing each failed target's id, error code and message. Previously PutTargets and RemoveTargets partial failures were ignored and the deploy recorded success.
