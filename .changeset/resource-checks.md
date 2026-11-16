---
"@notation/resource": minor
"@notation/reconciler": minor
---

A resource takes a `checks` option beside `config` and `dependencies`. It maps a param name to a Standard Schema that the param's value must pass, in addition to the validator in the class's schema. A check runs after the class's validator, at declaration, at plan and at deploy. It does not run on the result of `read`, `create` or `rotate`, so a value that a read returns is planned as a change. At declaration a check does not run on a collected param, because a contribution can supply a field that config leaves out. A failed check throws `ValueValidationError`, as a failed class validator does. Issues that an unknown value could cause are dropped, as for a class validator. A check that names a field that is not a param fails at declaration with `SchemaStructureError`.

`validateParams` takes `{ partial: true }` for params that leave out some contributions. The class's validators run on them, and the checks do not. Deploy sets it for the placeholder of a cycle and for a delete-first replace that leaves out the contributions of the resources it deleted. The check runs in the pass that reconciles the resource with its full params.

`contribute` records the call site in the user's code, and skips frames in node_modules and in the @notation packages, as `declaredAt` does. A contribution that a library makes for the user, such as one from a declaration in `@notation/aws` or `@notation/cloudflare`, now names the user's line in a conflict error. The stack is formatted only when an error or the order of two equal contributions needs the call site. So `CollectContext.contributors` now holds a function for each item, which returns its call site. A custom `collect` function calls it only when a message needs it.

`diffParams` counts a change between an array and an object at the same path as a change, at any depth. `deep-object-diff` finds no change between `{}` and `[]`, or between `{ "0": "x" }` and `["x"]`. The plan display shows the new value at that path. `changedKeys` counts it too.
