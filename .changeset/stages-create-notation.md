---
"create-notation": minor
---

The starter app has a `notation.config.ts` that names the entry file `infra/api.ts`, and its scripts no longer pass the entry path. The config's `app` is the name of the new app, changed to be name-safe. `@notation/core` is installed with the other packages, because the config imports `defineConfig` from it.
