---
"create-notation": minor
---

The starter app has a `notation.config.ts`, and its scripts no longer pass an entry path. The config's `app` is the project name, made name-safe. `@notation/core` is installed, because the config imports `defineConfig` from it.
