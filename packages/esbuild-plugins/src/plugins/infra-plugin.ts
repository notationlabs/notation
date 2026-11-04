import path from "node:path";
import esbuild, { type Message, type Plugin, type PluginBuild } from "esbuild";
import { toProjectRoot } from "@notation/core";
import {
  createInfraEntry,
  createStandInModule,
  runtimeLinkSpecifier,
  standInPrefix,
} from "src/codegen/codegen";
import { parseModule, ownExportNames } from "src/infra-phase/module-info";
import {
  strippedPrefix,
  stripRuntimeModules,
  type Resolved,
  type StrippedModules,
} from "src/infra-phase/strip";
import { matchesRuntimeModules } from "src/runtime-modules";
import { isLocalModule } from "src/utils/is-local";
import { GetFile, fsGetFile, withFileCheck } from "src/utils/get-file";

type PluginOpts = {
  /**
   * Globs for the files that are runtime modules. Infra that imports one of
   * them without `with { type: "runtime" }` fails.
   */
  runtimeModules: string[];
  getFile?: GetFile;
  /**
   * Called after each build without errors, with the absolute paths of the
   * runtime modules that infra imports with `type: "runtime"`, sorted.
   */
  onRuntimeModules?: (modules: string[]) => void;
  /**
   * Where generated code imports `@notation/resource` from. It must be the
   * copy that collects the resource graph. Defaults to the copy that this
   * package resolves.
   */
  runtimeLink?: string;
};

const pluginName = "notation-infra";
const namespaces = {
  entry: "notation-infra-entry",
  standIn: "notation-standin",
  stripped: "notation-stripped",
};
// Marks the resolutions that this plugin asks esbuild for, so that its own
// callbacks let them through.
const internal = Symbol.for("@notation/esbuild-plugins/internal");

/**
 * Bundles the infra phase. It evaluates in four steps:
 *
 * 1. A `type: "runtime"` import resolves to a stand-in module, which exports
 *    one stand-in per export of the runtime module.
 * 2. Infra modules evaluate. Infra APIs record the stand-ins they are given.
 * 3. A stripped copy of each runtime module evaluates, which keeps only what
 *    declaring its functions needs.
 * 4. The stand-ins link to the runtime modules' exports.
 *
 * Which runtime modules there are is only known once infra has been
 * resolved, so each build starts with a scan: a build of infra that only
 * finds the runtime modules. The stripped copies come from the scan's
 * result.
 */
export function infraPlugin(opts: PluginOpts): Plugin {
  return createPlugin(opts, "build");
}

function createPlugin(
  opts: PluginOpts,
  mode: "build" | "scan",
  onScan?: (modules: string[]) => void,
): Plugin {
  const getFile = withFileCheck(opts.getFile || fsGetFile);
  const runtimeLink = opts.runtimeLink ?? resolveRuntimeLink();

  return {
    name: pluginName,
    setup(build) {
      const found = new Set<string>();
      let runtimeModules: string[] = [];
      let stripped: StrippedModules = { modules: new Map(), files: [] };
      const resolve = createResolver(build);

      build.onStart(async () => {
        found.clear();
        if (mode === "scan") return;
        runtimeModules = [];
        stripped = { modules: new Map(), files: [] };
        try {
          runtimeModules = await scan(build, opts);
        } catch {
          // The scan builds the same infra with the same checks, so the build
          // fails with the same errors, and reports them once.
          return;
        }
        try {
          stripped = await stripRuntimeModules(runtimeModules, {
            getFile,
            resolve,
            isRuntimeModule: (file) =>
              matchesRuntimeModules(file, opts.runtimeModules),
            describe: toProjectRoot,
          });
        } catch (error) {
          return { errors: toMessages(error) };
        }
      });

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[internal]) return;
        if (args.path === runtimeLinkSpecifier) {
          return { path: runtimeLink, external: true };
        }
        if (args.path.startsWith(standInPrefix)) {
          return {
            path: args.path.slice(standInPrefix.length),
            namespace: namespaces.standIn,
          };
        }
        if (args.path.startsWith(strippedPrefix)) {
          return {
            path: args.path.slice(strippedPrefix.length),
            namespace: namespaces.stripped,
          };
        }
        if (args.kind === "entry-point") {
          if (mode === "scan") return;
          const entry = await build.resolve(args.path, {
            kind: "entry-point",
            resolveDir: args.resolveDir,
            pluginData: { [internal]: true },
          });
          if (entry.errors.length > 0) return { errors: entry.errors };
          return { path: entry.path, namespace: namespaces.entry };
        }

        const type = args.with?.type;
        if (type === "infra" && args.namespace === "file") {
          return {
            errors: [
              {
                text: `with { type: "infra" } is only valid in runtime modules, and ${toProjectRoot(args.importer)} is an infra module. Import ${args.path} without an attribute.`,
              },
            ],
          };
        }
        if (type !== "runtime") return;
        const target = await resolve(args.path, args.importer);
        if (!target.local) {
          return {
            errors: [
              {
                text: `${args.path} is imported with { type: "runtime" }, so it must be a runtime module of this project, not a package.`,
              },
            ],
          };
        }
        found.add(target.path);
        return { path: target.path, namespace: namespaces.standIn };
      });

      build.onLoad({ filter: /.*/, namespace: namespaces.entry }, (args) => ({
        contents: createInfraEntry(
          args.path,
          runtimeModules.map((file) => ({
            path: file,
            module: toProjectRoot(file),
          })),
        ),
        loader: "js",
        resolveDir: path.dirname(args.path),
        watchFiles: stripped.files,
      }));

      build.onLoad(
        { filter: /.*/, namespace: namespaces.standIn },
        async (args) => {
          const { names, files } = await readExportNames(
            args.path,
            getFile,
            resolve,
          );
          return {
            contents: createStandInModule(toProjectRoot(args.path), names),
            loader: "js",
            resolveDir: path.dirname(args.path),
            watchFiles: files,
          };
        },
      );

      build.onLoad({ filter: /.*/, namespace: namespaces.stripped }, (args) => {
        const contents = stripped.modules.get(args.path);
        if (contents === undefined) {
          return {
            errors: [
              {
                text: `No stripped copy of ${toProjectRoot(args.path)}. This is a bug in the Notation compiler.`,
              },
            ],
          };
        }
        return {
          contents,
          loader: loaderFor(args.path),
          resolveDir: path.dirname(args.path),
          watchFiles: [args.path],
        };
      });

      build.onLoad(
        { filter: /\.[cm]?[jt]sx?$/, namespace: "file" },
        async (args) => {
          if (!matchesRuntimeModules(args.path, opts.runtimeModules)) return;
          const source = await getFile(args.path);
          const info = parseModule(args.path, source);
          const name = toProjectRoot(args.path);
          const message = ownExportNames(info).includes("resource")
            ? resourceExportMessage(name)
            : `${name} is a runtime module, so infra must import it with { type: "runtime" }.`;
          return { errors: [{ text: message }], watchFiles: [args.path] };
        },
      );

      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        const modules = [...found].sort();
        onScan?.(modules);
        if (mode === "build") opts.onRuntimeModules?.(modules);
      });
    },
  };
}

// Builds infra without writing it, to find the runtime modules that infra
// imports with `type: "runtime"`.
async function scan(build: PluginBuild, opts: PluginOpts): Promise<string[]> {
  let modules: string[] = [];
  const scanPlugin = createPlugin(opts, "scan", (found) => {
    modules = found;
  });
  const { initialOptions } = build;
  await esbuild.build({
    ...initialOptions,
    write: false,
    metafile: false,
    sourcemap: false,
    logLevel: "silent",
    plugins: (initialOptions.plugins ?? []).map((plugin) =>
      plugin.name === pluginName ? scanPlugin : plugin,
    ),
  });
  return modules;
}

function createResolver(build: PluginBuild) {
  const cache = new Map<string, Promise<Resolved>>();
  return (specifier: string, importer: string): Promise<Resolved> => {
    const key = `${importer}\0${specifier}`;
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = build
        .resolve(specifier, {
          importer,
          resolveDir: path.dirname(importer),
          kind: "import-statement",
          pluginData: { [internal]: true },
        })
        .then((result) => {
          if (result.errors.length > 0) {
            throw new Error(
              `Could not resolve ${specifier} from ${toProjectRoot(importer)}: ${result.errors[0]!.text}`,
            );
          }
          return {
            path: result.path,
            local: isLocalModule(result),
          };
        });
      cache.set(key, resolved);
    }
    return resolved;
  };
}

/**
 * The value exports of a runtime module, following `export *`, and the files
 * read to find them. A module that exports `resource` uses the shape that
 * this compiler replaced, so it fails with a migration message.
 */
async function readExportNames(
  file: string,
  getFile: (file: string) => string | Promise<string>,
  resolve: (specifier: string, importer: string) => Promise<Resolved>,
) {
  const names = new Set<string>();
  const files: string[] = [];
  const read = async (current: string, isEntry: boolean) => {
    if (files.includes(current)) return;
    files.push(current);
    const info = parseModule(current, await getFile(current));
    const own = ownExportNames(info);
    if (isEntry && own.includes("resource")) {
      throw new Error(resourceExportMessage(toProjectRoot(current)));
    }
    for (const name of own) {
      if (isEntry || name !== "default") names.add(name);
    }
    for (const star of info.starExports) {
      if (star.attribute !== undefined) continue;
      const target = await resolve(star.source, current);
      if (target.local) await read(target.path, false);
    }
  };
  await read(file, true);
  return { names: [...names], files };
}

function resourceExportMessage(name: string) {
  return `${name} exports \`resource\`, which runtime modules no longer use. Declare the function by calling lambda() from "@notation/aws/lambda", imported with { type: "infra" }: \`const { handle } = lambda({ id: "...", timeout: 5 })\`. Make each handler with that handle, remove the \`resource\` export, and import the module from infra with { type: "runtime" }.`;
}

function loaderFor(file: string): esbuild.Loader {
  if (/\.[cm]?tsx$/.test(file)) return "tsx";
  if (/\.[cm]?jsx$/.test(file)) return "jsx";
  if (/\.[cm]?js$/.test(file)) return "js";
  return "ts";
}

function toMessages(error: unknown): Partial<Message>[] {
  const errors = (error as { errors?: Message[] })?.errors;
  if (Array.isArray(errors) && errors.length > 0) return errors;
  return [{ text: error instanceof Error ? error.message : String(error) }];
}

/**
 * The URL of the copy of `@notation/resource` that this package resolves,
 * which generated infra code links runtime modules with. Code that collects
 * the graph of an infra bundle must use the same copy.
 */
export function resolveRuntimeLink(): string {
  try {
    return import.meta.resolve("@notation/resource");
  } catch {
    return "@notation/resource";
  }
}
