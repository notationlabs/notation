---
"@notation/resource": minor
"@notation/aws": minor
"@notation/cloudflare": minor
"@notation/build": minor
---

Output refs are typed as refs (RFC 0027). `resource.outputRef(key)` returns an `OutputRef<T>`, `resource.credentials.<name>` a `CredentialRef<T>`, and `resource["~state"].outputRef(key)` a `StateRef<T>`. A ref used as a string, such as `new URL(queue.url)`, now fails the type check. `outputRef` no longer removes `undefined` from an optional output.

- `@notation/resource` exports the types `Input<T>`, `DeepInput<T>`, `Resolved<T>` and `Derived<T>`, and `text`, `all` and `map` to compute with refs: `` text`${queue.arn}-*` ``, `api.url.map((url) => new URL(url).host)`. `isDerived` checks whether a value is a derived value. Plan shows a derived value once its refs are known, and only its own path is unknown before then. A resource's `config` and `contribute` take `DeepInput` of the params. `text` and `all` are marked `@resource`, so a function bundle that calls them fails to build.
- Each ref has a `kind`: `"output"`, `"credential"` or `"state"`. `StateOutputRef` is removed: a `~state` ref has the kind `"state"`. `isCredentialRef` and `isStateRef` check the kind. `outputRef(key)` throws for a credential key: use `credentials.<key>`.
- `deriveParams` receives config, and the config of its dependencies, with their refs filled in. At plan, reading an unknown ref in config throws `PendingOutput`. So does reading a credential that plan expects deploy to rotate. Reading a value in config that is a ref to the resource's own physical name, or a credential, throws, at plan and at deploy. A `deriveParams` that annotates `deps` types it as `ResolvedDependencies<Deps>`. A helper that `deriveParams` calls with `deps.x`, and that types its argument as a resource instance type such as `WorkerScriptInstance`, must type it as `ResolvedDependencies<Deps>[K]` instead, because the type of `deps.x` leaves out the instance's private members.
- `contribute` takes a `~state` ref only where the value can be `undefined`, because the ref resolves to `undefined` when state has no record.
- `contribute(fn, { deps })` is deprecated, on a resource and on `kvJson()`. Contribute values with `text`, `map` or `all` instead. At deploy, the function receives the config of its deps with their refs filled in, as at plan.
- A `map` function that returns a promise, a function, or an object that is not a plain object or an array, such as a `URL` or a `Date`, fails, at any depth.
- `OutputRefStringError` names `text` and `map` as the fix.
- `@notation/aws`: `queue.arn`, `queue.url`, `bus.arn` and `bus.name` are `OutputRef<string>`. A `$lambda`'s `env`, a dead-letter queue's `queue`, and a `PolicyStatement`'s `Resource` take `Input<string>`. `lambda.env()` and `LambdaEnv` give plain values. `env` is `EnvVars`, a `Record<string, Input<string> | CredentialRef<string>>`, and `env()` and `LambdaEnv` give a credential as a `string`. The role policy's params hold `ResolvedPolicyStatement`.
- `@notation/cloudflare`: a Worker's binding takes `Input<string> | CredentialRef<string>`. An output ref or a derived value that isn't a credential binds as plain text, where it failed before. A Worker that binds an R2 bucket whose `Jurisdiction` is a ref fails. `environmentVariables` of a container take `Record<string, Input<string>>`, and `kvJson()`'s `value` and `contribute` take `DeepInput`. When the `Condition`, `ExpiresOn` or `NotBefore` of an `AccountToken` holds an unknown ref, plan marks every param that config doesn't set as unknown. Before, only the path of the ref was unknown.
- `@notation/build`: `Bundle` types its config as plain values. The analysis of a module counts a tagged template, such as `` text`…` ``, as a call of its tag.
