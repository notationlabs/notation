---
"@notation/cli": minor
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
"@notation/cloudflare": minor
---

`notation deploy --replace <id>@<hash>` replaces a resource whose params have not changed, as a changed param that forces replacement would. The hash is the resource's instance hash in the stage, so a command copied from another stage fails. `notation plan --replace <id>` plans the replace and prints the deploy command with the hash, and `plan --json` adds `instanceHash` to each node with a record. The R2 bucket and the KV namespace refuse a replace in `rejectChange`, and `--override-loss-protection <id>` turns that check off for a resource that `--replace` names. The request is saved with the execution, and a resume uses it.
