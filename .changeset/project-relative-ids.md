---
"@notation/core": minor
"@notation/cli": minor
"@notation/esbuild-plugins": minor
"@notation/std.iac": minor
---

Paths are now relative to the project root (the nearest directory with a package.json, starting from the working directory), not the working directory. This covers deployment IDs, Lambda IDs, build output, the state database and the files that file and zip resources read. You can run the CLI from any folder inside the project and get the same result.

This is a breaking change. Deployment IDs used to be absolute paths, so Notation will not find the state of existing deployments. Destroy them before upgrading, or redeploy and delete the old resources by hand.
