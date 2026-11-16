# Bundle

`bundle()` from `@notation/build/resources` declares code that deploy builds with Rolldown. It is for a library that generates the code of a function from its config, such as a router that generates a Worker from a route table. That code only exists once the infra code has run, and `notation compile` has finished by then, so the compiler can't build it.

A bundle is a resource. Pass it as the `code` of [`lambda()`](../providers/aws/lambda.md#a-bundle-as-the-code) or [`worker()`](../providers/cloudflare/workers.md#workerconfig-1).

## `bundle(options)`

A router library generates the route table as a module, and builds it with a template that it ships:

```ts [node_modules/acme-router/index.js]
import { fileURLToPath } from "node:url";
import { bundle } from "@notation/build/resources";
import { worker } from "@notation/cloudflare/workers";

export function router({ id, routes }) {
  const code = bundle({
    id,
    platform: "workerd",
    entry: fileURLToPath(new URL("./template.js", import.meta.url)),
    modules: {
      "virtual:routes": `export default ${JSON.stringify(routes)};`,
    },
  });
  return worker({ id, code, compatibilityDate: "2026-10-12" });
}
```

```js [node_modules/acme-router/template.js]
import routes from "virtual:routes";

export default {
  fetch(request) {
    const body = routes[new URL(request.url).pathname];
    return new Response(body ?? "not found", { status: body ? 200 : 404 });
  },
};
```

| Option     | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | Keys the bundle in state, as `bundle:<id>`. Use 1 to 64 letters, digits, hyphens or underscores. The output is written to `dist/.bundles/<id>/`.                                                                                                                                                                                                        |
| `platform` | `node` builds the bundle with the options of a `$lambda` bundle, and `workerd` with those of a `$worker` bundle: the same export conditions, defines and handling of `node:` imports.                                                                                                                                                                   |
| `entry`    | The module that the bundle starts from: an absolute path, a path relative to the project root, or a key of `modules`.                                                                                                                                                                                                                                   |
| `modules`  | Generated modules, by import specifier. The entry and the modules that it imports can import them. A specifier can't start with `.` or `/`. A key matches that specifier in every module that the bundle loads, including installed packages, so use a prefix such as `virtual:`. A source is JavaScript, unless its specifier ends in `.ts` or `.tsx`. |

The entry can be a key of `modules`, so a library can generate the whole script:

```ts
bundle({
  id: "redirects",
  platform: "workerd",
  entry: "virtual:main",
  modules: { "virtual:main": renderRedirectWorker(config) },
});
```

The build writes one file. A dynamic import is put in the same file, because a Worker upload sends one module and the Lambda zip holds one file. For `node`, Rolldown bundles every installed package and leaves only Node's built-in modules external.

### The bundle holds no infra code

A bundle is plain code. It applies only the platform's own plugins, and none of the compiler's: it doesn't strip declarations, and its code can't call `env()` or `decode()`. The build fails when the output holds code from an infra module of the project, or a function of a package that is marked `@resource` or `@declaration`. The error names the chain of imports from the entry:

```text
infra/region.ts, an infra module (files.infra: "infra/**", the default), can't be used in bundle:router, because an infra module only runs at deploy. The code uses region at src/worker.ts:2:35, and imports infra/region.ts through src/worker.ts → infra/region.ts. …
```

A library passes values to its code through `modules`, as the router passes its routes, or through the bindings of the Worker.

### Exports

`bundle()` reads the exports of the entry when it is called. It parses the entry, from its file or from its source in `modules`, and keeps the names of its value exports and the specifiers of its `export *` statements. `lambda()` reads them to check the handler, and `worker()` reads them to find the Durable Object namespaces that the Worker hosts.

- **Only the entry is read.** A name that the entry re-exports with `export *` is not known. A library that generates the entry can export each class by name.
- **A CommonJS entry has no exports.**
- **For `workerd`, an export that workerd can't start fails at once**, as for a `$worker`. An example is `export const NAME = "x"`.

The build checks that the output exports each name that `bundle()` read.

## The resource

`bundle:<id>` has these params:

| Param        | Value                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Id`         | The `id`.                                                                                                                                                                                                                                                                                                                                  |
| `Entry`      | The entry, as a path relative to the project root, or the key of `modules`. A path that is only under the real path of the root, such as one from `import.meta.url` when the root is a symlink, is relative to that real path. The param changes when the entry's real path changes, such as when pnpm upgrades the package that holds it. |
| `Platform`   | `node` or `workerd`.                                                                                                                                                                                                                                                                                                                       |
| `FilePath`   | The file that the bundle writes, relative to the project root.                                                                                                                                                                                                                                                                             |
| `FileSha256` | The base64 SHA-256 of the file that the bundle writes.                                                                                                                                                                                                                                                                                     |

**The hash of the built file is the param, not the sources.** Plan builds the bundle in memory and compares the hash with the one in state. A change to the template that doesn't change the output plans no update. The sources of `modules` are not stored in state.

Its outputs are `filePath` and `fileSha256`, the base64 SHA-256 of the file on disk, as for a `std.fs.File`:

| Platform  | Files in `dist/.bundles/<id>/` | `filePath`  |
| --------- | ------------------------------ | ----------- |
| `node`    | `index.mjs` and `index.zip`    | `index.zip` |
| `workerd` | `index.mjs`                    | `index.mjs` |

Deploy writes the files when it creates or updates the bundle. It checks first that the file has the hash that the plan expects, and fails otherwise:

```text
bundle:router built to SHA-256 mR8x…, but the plan expects PB3f…. An input of the bundle changed after the plan, or its build is not deterministic. Start a new deploy.
```

A bundle whose output is missing from disk reads as not found, so a deploy after `dist/` is cleaned writes it again. Deleting the bundle removes `dist/.bundles/<id>/`.

## Skipping the build

After each build, the bundle writes `dist/.bundles/<id>/inputs.json`:

```json [dist/.bundles/router/inputs.json]
{
  "key": "<sha256 of the options and the sources>",
  "files": {
    "node_modules/acme-router/package.json": "<sha256>",
    "node_modules/acme-router/template.js": "<sha256>",
    "pnpm-lock.yaml": "<sha256>"
  },
  "fileSha256": "<base64 sha256>"
}
```

- `key` is a hash of the entry, the platform, the sources of `modules`, the build options, the project's `files` globs, which the check for infra code uses, and the versions of `@notation/build` and Rolldown. The options of `workerd` hold `NODE_ENV`, so a deploy with another `NODE_ENV` builds again.
- `files` holds a hash of each file that the build read, and of each file that decides how its imports resolve: the nearest `package.json` and `tsconfig.json` of each module, each tsconfig that one of those extends, and the project's lockfile.

A plan doesn't build the bundle when the `key` is the same, each file in `files` has its recorded hash, and the output on disk has the recorded `fileSha256`. A build during which one of these files is modified doesn't write the inputs file, so the next plan builds again. In one process, a build is also kept in memory, so the plan and the create of one deploy build the bundle once.

The file is in `dist/`, not in `.notation/`, as it describes files on this machine. Cleaning `dist/` removes it, and the next plan builds again. [`notation watch`](../cli/watch.md#bundles) reads it to find the files to watch.

## Limits

- **A new file that changes a resolution is not seen.** The inputs file records the files that the build read, not the files that it looked for. For example, a new `src/y.tsx` beside an imported `src/y.ts` is not seen, though Rolldown tries `.tsx` first. Delete `dist/.bundles/` to force a build.
- **A fresh checkout builds every bundle at its first plan**, as it has no inputs files.
- **A build that is not deterministic fails at deploy.** A module that generates a timestamp or a random value causes it.
- **`import.meta.url` points to the library's file only for an installed library.** The infra build bundles a library in the project into `dist/`, so it gets the URL of a file in `dist/`. Such a library should pass a path relative to the project root.
- **One module.** A bundle can't add wasm or text modules, and takes no plugins, externals or source maps.
- **Rolldown loads during evaluation.** `bundle()` parses its entry with Rolldown's parser, so a program with a bundle loads Rolldown's native binding when the infra code runs.
