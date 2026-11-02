---
"create-notation": minor
---

The starter app has a `notation.config.ts`, and its scripts no longer pass an entry path. The config's `app` is the project directory name in lowercase, with each run of other characters replaced by `-`. The starter depends on `@notation/core`, because the config imports `defineConfig` from it.
