---
"@notation/build": patch
"@notation/cli": patch
---

The runtime build's bundle check now says that the function uses an infra module, or a resource function such as `queue()`, and names the file and line of each use. It used to say that the function's bundle includes it. The check reads the code before Rolldown's minify pass, so an unused call to an infra helper or to `queue()` fails the build even though the minify pass removes the call from the final bundle. The old wording was false in that case. The same builds pass and fail as before.

The error for a resource function now lists only the uses of that function. It used to list the uses of every resource function in the bundle.

For example:

```
The function in runtime/orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orderQueue at runtime/orders.ts:15:31. It imports infra/orders.ts through runtime/orders.ts → infra/orders.ts. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).
```
