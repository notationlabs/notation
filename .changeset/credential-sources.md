---
"@notation/cli": minor
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
---

`credentialSourceResource()` in `@notation/resource` builds a source: a value that exists outside notation, such as an environment variable. A source has one credential, `value`, which another resource takes as it takes a token's value. Plan and deploy call the source's `read` for its `revision`, and deploy calls `loadCredential` only when a resource that takes the value is created or updated and deploy holds no value. The credential's version is made from the source's params and its revision, so a new revision updates every resource that takes it. Deploy never replaces a source. `BaseResource` has a `kind` field, `"resource"` or `"credential-source"`.

`update` receives the value of a credential only when its version differs from the version in the resource's record. Every other credential in `patch` and `params` is `undefined`.

Deploy no longer replaces a resource to get a credential that has no `rotate`. Plan and deploy fail instead, and print two commands: `notation deploy --replace <id>@<hash>`, and `notation deploy --credential <id>.<credential>@<version>=<variable>`, which gives deploy a value that the user holds, from an environment variable. The version is the one in state, so a command copied from another stage fails. `notation plan --credential` plans it and prints the deploy command with the version, and `plan --json` adds `credentialVersions` to each node with a record. The `unheldCredentials` field of a plan node and the `credential` field of a replace field are removed.

`deployment()` in `@notation/core` returns the app and the stage while infra code is evaluated. `notation viz` takes `--stage` and evaluates the infra for it. Without `--stage` or `defaultStage`, it fails with "No stage given".
