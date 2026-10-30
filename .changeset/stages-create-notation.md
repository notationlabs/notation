---
"create-notation": minor
---

The starter app has a `notation.config.ts`, and its scripts take the entry name `api` instead of the path `infra/api.ts`. The config's `app` is the name of the new app, changed to be name-safe. `@notation/core` is installed with the other packages, because the config imports `defineConfig` from it.
