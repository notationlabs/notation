---
"@notation/build": patch
---

The build errors for a value that only exists at deploy now state the rule: the function can't use it, and why. They used to describe how the compiler builds the function. The same builds pass and fail as before.

Each error says what can't be used, where, and why, and then what to move. For example, a function that reads a queue from a file with no kind:

```
runtime/orders.ts:11:27: dlq can't be used in the `event` option of $lambda(), which the function uses, because it comes from lib/queues.ts, and loading lib/queues.ts calls queue(), which only runs at deploy. Read infra values in the function through the declaration's env(). Move a plain value that the option needs to a shared module (files.shared), or to a file that no glob matches and that doesn't call a resource function.
```

It used to say:

```
runtime/orders.ts:11:27: an option of $lambda that the function keeps refers to dlq, from lib/queues.ts. lib/queues.ts calls queue at its top level, so the function can't load it. The runtime build removes infra. Read infra values in the function through the declaration's env(). Move a plain value that a kept option uses to a shared module (files.shared), or to a file that no glob matches.
```

The errors for a shared module and for a declaration in an infra or shared module have the same form. The error for an import of a runtime module's value at deploy no longer starts with `Illegal import:`.
