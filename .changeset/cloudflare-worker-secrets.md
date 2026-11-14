---
"@notation/cloudflare": minor
---

A Worker's secrets are set with Cloudflare's secrets API for the Worker, before its code is uploaded, and `notation secret set` can set them.

- `workerSecret({ id, source?, key? })` takes an optional source and key. The value comes from the source, or from the prompt when there is no source. `notation secret set` writes a Worker secret to each deployed Worker that binds it, and fails when none is deployed. `notation secret delete` deletes it from each of them.
- The new `WorkerSecret` resource sets one secret of a Worker with Cloudflare's secrets API for the Worker. A Worker gets one for each Worker secret that it binds. It writes a sourced value when the source's version changes, and a value without a source only when the Worker doesn't have it. It deletes the secret when the Worker stops binding it.
- The new `WorkerScriptPlaceholder` resource makes sure a Worker exists before its secrets are set. Deploy sets a Worker's secrets before it uploads the Worker's code, so the code never runs without them. A new Worker that binds a Worker secret is first uploaded as a placeholder that answers 503 and has the tag `notation-placeholder`. Then deploy sets its secrets, and then uploads its code, which removes the tag. A live Worker that gains its first secret keeps its name, and gets no placeholder upload. The placeholder refuses a Worker that exists without the tag, unless it is the Worker in state.
- A deploy that stops at a secret without a source, such as in CI with no terminal, leaves only the placeholder live. `notation secret set` writes the value to the placeholder, and the next deploy uploads the code.
- Destroy deletes a Worker first, which deletes its secrets with it, and then the placeholder if it still has the tag. If the Worker's delete fails, destroy stops there.
- `WorkerScript` takes `ScriptName` in config, for a Worker created with the name of its placeholder. The name in its state record wins. Its create uploads over a Worker with the placeholder tag.
- `WorkerScript` no longer takes the `SecretBindings` param, and no longer uploads secrets as `secret_text` bindings. Each upload keeps the Worker's `secret_text` bindings, so an upload never needs a secret's value. This also keeps a secret set with `wrangler secret put`, which an upload deleted before.
