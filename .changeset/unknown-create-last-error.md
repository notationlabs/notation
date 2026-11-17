---
"@notation/reconciler": patch
---

When a create's outcome stays unknown after the last attempt, the error now gives the error that the last attempt ended with, in its message and as its cause. Before, it said only `The outcome of effect "…" is still unknown after 10 attempts`. The last attempt can be a create, such as a `docker push` that timed out, or a lookup that failed. A lookup that reports an unknown status without throwing gives no error, so the message stays as before.
