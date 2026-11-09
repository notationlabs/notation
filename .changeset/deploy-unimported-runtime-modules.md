---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": patch
---

Deploy now includes runtime modules that infra doesn't import. The infra build reads each file that `files.runtime` in `notation.config.ts` matches. The infra bundle imports the entry first, and then each of these files that calls a declaration function, such as `$lambda`. A file without a declaration is not imported.

- `infraEntryPlugin()` and `infraEntry` in `@notation/build` generate this entry.
- In watch mode, the base directory of each `files.runtime` glob is watched, or its nearest existing parent, so a new runtime file is deployed without a restart.
- The scan and the infra watcher skip `dist/`, `node_modules/` and dot-directories at any depth. `infraWatchExclude` holds the watcher's globs.
- A file in the globs that can't be parsed fails the build, and the error names the file.
