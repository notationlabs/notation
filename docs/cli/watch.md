# notation watch

```sh
notation watch [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Hot Infra Replacement – the development workflow.

```sh
notation watch --stage dev
```

## What it does

1. Compiles infra and runtime with Rolldown in watch mode. When an infra rebuild finds a different set of runtime modules, the runtime builds restart for the new set.
2. Deploys the initial stack.
3. Watches `dist/` for changes (debounced at 500ms).
4. On change, redeploys – only changed resources are updated (same reconciler as `deploy`).
5. Queues deploys if one is already in progress.

## Bundles

A [bundle](../reference/bundle.md) reads files that the infra build doesn't watch, such as a template in a package. After each deploy, `watch` reads `dist/.bundles/*/inputs.json` and watches the files listed in `files`. A change to one of them starts a deploy, after the same debounce. `watch` stops watching a file that no inputs file lists any more.

- **A file in `node_modules` is not watched**, so an edit to an installed package doesn't redeploy. A linked workspace package resolves to its real path outside `node_modules`, so an edit to a library in the same workspace does redeploy.
- **Writing a bundle doesn't start a deploy.** The output is in `dist/.bundles/`, and `watch` ignores dot directories.
- **A deleted output is not written again.** `watch` deploys without drift detection, so a deploy after `dist/` is cleaned plans no change for the bundle. Run `notation deploy` to write it again.
- **Stages that deploy from the same machine share `dist/.bundles/`.** After another stage writes a bundle, `watch` can fail to upload the bundle's file until `notation deploy` runs, which rewrites the file.

## Secrets

Each deploy runs in its own process, which shares the terminal with `watch`. A deploy that needs the value of a secret without a source asks for it on the terminal. `watch` doesn't keep the answer, so each later deploy that needs the value asks again. See [Secrets](../manual/secrets.md).

## Changing the config

`watch` reads the config once, when it starts. If the config file changes, `watch` waits for any running deploy to finish, then exits with code 1. Start `watch` again to use the new config.

`watch` deploys real AWS resources. Several developers can share one AWS account if each developer uses their own stage, such as `--stage dev-alice`, because [AWS names](../manual/project-config.md#aws-names) contain the stage. To remove the resources of the stage, run `notation destroy --stage dev-alice`.

Production deployments use `notation deploy`, not `watch`.
