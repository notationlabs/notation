---
"@notation/cli": minor
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
---

`credentialSourceResource()` in `@notation/resource` builds a source: a value that exists outside notation, such as an environment variable. A source has one credential, `value`, which another resource takes as it takes a token's value. Plan and deploy call the source's `read` for its `revision`, and deploy calls `loadCredential` only when a resource that takes the value is created or updated and deploy holds no value. The credential's version is made from the source's params and its revision, so a new revision updates every resource that takes it. Deploy never replaces a source. `BaseResource` has a `kind` field, `"resource"` or `"credential-source"`.

`update` receives the value of a credential only when its version differs from the version in the resource's record. Every other credential in `patch` and `params` is `undefined`.

Deploy no longer replaces a resource to get a credential that has no `rotate`. Plan and deploy fail instead. The error gives the reason that a resource needs the value, and prints two commands: `notation deploy --credential <id>.<credential>@<hash>=<variable>`, which gives deploy a value that the user issues at the provider, from an environment variable, and `notation deploy --replace <id>@<hash>`. The hash of both flags is the instance hash of the resource, so a command copied from another stage fails. `notation plan --credential` plans it and prints the deploy command with the hash. The `unheldCredentials` field of a plan node and the `credential` field of a replace field are removed.

A resource class can give `rotateManually`, one sentence for each credential without `rotate` that tells the user how to issue a new value at the provider. The error prints it above the `--credential` command.

`deployment()` in `@notation/core` returns the app and the stage while infra code is evaluated. `notation viz` takes `--stage` and evaluates the infra for it. Without `--stage` or `defaultStage`, it fails with "No stage given".
