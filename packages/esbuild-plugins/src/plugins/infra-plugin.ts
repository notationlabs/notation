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
import {
  findUnwiredRuntimeModules,
  listProjectScripts,
  type UnwiredModule,
} from "src/infra-phase/unwired";
import { matchesRuntimeModules, moduleKey } from "src/runtime-modules";
import { isLocalModule } from "src/utils/is-local";
import { isScript, loaderFor } from "src/utils/script";
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
   * Lists the files that may be runtime modules, as absolute paths. A file
   * that matches the globs and calls a provider factory, but that nothing
   * imports with `type: "runtime"`, gets a warning. Defaults to the scripts
   * under the project root.
   */
  listFiles?: () => string[] | Promise<string[]>;
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
      let stripped: StrippedModules = {
        modules: new Map(),
        files: [],
        infraModules: [],
      };
      const resolve = createResolver(build);
      // A file that infra imports with `type: "runtime"` is a runtime module,
      // whether or not it matches the globs.
      const isRuntimeModule = (file: string) =>
        matchesRuntimeModules(file, opts.runtimeModules) ||
        runtimeModules.includes(file);

      build.onStart(async () => {
        found.clear();
        if (mode === "scan") return;
        runtimeModules = [];
        stripped = { modules: new Map(), files: [], infraModules: [] };
        // An infra module that runtime code imports with `type: "infra"` can
        // import more runtime modules. If infra doesn't import it, scan again
        // with it as an entry, until every infra module has been scanned.
        const extraEntries: string[] = [];
        for (;;) {
          let scanned: Awaited<ReturnType<typeof scan>>;
          try {
            scanned = await scan(build, opts, extraEntries);
          } catch (error) {
            // The first scan builds the same infra with the same checks, so
            // the build fails with the same errors, and reports them once.
            if (extraEntries.length === 0) return;
            return { errors: toMessages(error) };
          }
          runtimeModules = scanned.modules;
          try {
            stripped = await stripRuntimeModules(runtimeModules, {
              getFile,
              resolve,
              isRuntimeModule,
              describe: toProjectRoot,
            });
          } catch (error) {
            return { errors: toMessages(error) };
          }
          const unscanned = stripped.infraModules.filter(
            (file) => !scanned.files.has(file),
          );
          if (unscanned.length === 0) break;
          // The scan's files come from the metafile, and the infra modules
          // from build.resolve. If the two give different paths for a file,
          // scanning it again doesn't help.
          const repeated = unscanned.find((file) =>
            extraEntries.includes(file),
          );
          if (repeated) {
            return { errors: [{ text: unscannedMessage(repeated) }] };
          }
          extraEntries.push(...unscanned);
        }
        const unwired = await findUnwiredRuntimeModules({
          files: await (opts.listFiles ?? listProjectScripts)(),
          runtimeModules: opts.runtimeModules,
          wired: runtimeModules,
          getFile,
          resolve,
        });
        return {
          warnings: unwired.map((module) => ({
            text: unwiredMessage(module, entryFileOf(build)),
          })),
        };
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
        // The scan doesn't know all runtime modules until it ends, so the
        // build reports a runtime module that infra imports without the
        // attribute, not this.
        if (type === "infra" && args.namespace === "file" && mode === "build") {
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
          stripped.infraModules.map((file) => ({
            path: file,
            module: moduleKey(file),
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
          if (!isRuntimeModule(args.path)) return;
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
// imports with `type: "runtime"`, and the files that infra is made of.
// `extraEntries` are infra modules to scan as well.
async function scan(
  build: PluginBuild,
  opts: PluginOpts,
  extraEntries: string[],
): Promise<{ modules: string[]; files: Set<string> }> {
  let modules: string[] = [];
  const scanPlugin = createPlugin(opts, "scan", (found) => {
    modules = found;
  });
  const { initialOptions } = build;
  const cwd = initialOptions.absWorkingDir ?? process.cwd();
  // Several entries need an outdir. The scan writes nothing, so any will do.
  const output =
    extraEntries.length === 0
      ? {}
      : {
          outfile: undefined,
          outdir:
            initialOptions.outdir ??
            (initialOptions.outfile
              ? path.dirname(path.resolve(cwd, initialOptions.outfile))
              : cwd),
        };
  const result = await esbuild.build({
    ...initialOptions,
    ...output,
    entryPoints: withEntries(initialOptions.entryPoints, extraEntries),
    write: false,
    metafile: true,
    sourcemap: false,
    logLevel: "silent",
    plugins: (initialOptions.plugins ?? []).map((plugin) =>
      plugin.name === pluginName ? scanPlugin : plugin,
    ),
  });
  const files = new Set(
    Object.keys(result.metafile.inputs)
      .filter((input) => !/^[\w-]+:/.test(input))
      .map((input) => path.resolve(cwd, input)),
  );
  return { modules, files };
}

function withEntries(
  entryPoints: esbuild.BuildOptions["entryPoints"],
  extra: string[],
): esbuild.BuildOptions["entryPoints"] {
  if (extra.length === 0) return entryPoints;
  const added = extra.map((file, index) => ({
    in: file,
    out: `__notation-scan-${index}`,
  }));
  if (Array.isArray(entryPoints)) {
    return [...entryPoints, ...added] as esbuild.BuildOptions["entryPoints"];
  }
  return {
    ...entryPoints,
    ...Object.fromEntries(added.map((entry) => [entry.out, entry.in])),
  };
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
      if (target.local && isScript(target.path)) {
        await read(target.path, false);
      }
    }
  };
  await read(file, true);
  return { names: [...names], files };
}

// The entry file, when the build has one, as an absolute path.
function entryFileOf(build: PluginBuild): string | undefined {
  const { entryPoints, absWorkingDir } = build.initialOptions;
  const entries = Array.isArray(entryPoints)
    ? entryPoints
    : Object.values(entryPoints ?? {});
  if (entries.length !== 1) return undefined;
  const entry = entries[0]!;
  const file = typeof entry === "string" ? entry : entry.in;
  return path.resolve(absWorkingDir ?? process.cwd(), file);
}

function unwiredMessage(module: UnwiredModule, entryFile: string | undefined) {
  const name = toProjectRoot(module.file);
  const from = entryFile ? path.dirname(entryFile) : path.dirname(module.file);
  let specifier = path
    .relative(from, module.file)
    .split(path.sep)
    .join("/")
    .replace(/\.[cm]?[jt]sx?$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const where = entryFile ? ` in ${toProjectRoot(entryFile)}` : "";
  return `${name} matches runtimeModules and imports ${module.factory} with { type: "infra" }, but no infra module imports it with { type: "runtime" }, so its functions aren't deployed. To deploy them, import it from infra, as in \`import * as handlers from "${specifier}" with { type: "runtime" };\`${where}, and pass its handlers to infra APIs such as route() or consume().`;
}

function unscannedMessage(file: string) {
  const name = toProjectRoot(file);
  return `The compiler scanned ${name} as an entry, but the scan's files don't include it. ${name} is an infra module that runtime code imports with { type: "infra" }. As an entry, its path may resolve to another file, as through a symlink, or the build may mark it as external.`;
}

function resourceExportMessage(name: string) {
  return `${name} exports \`resource\`, which runtime modules no longer use. Declare the function by calling lambda() from "@notation/aws/lambda", imported with { type: "infra" }: \`const { handle } = lambda({ id: "...", timeout: 5 })\`. Make each handler with that handle, remove the \`resource\` export, and import the module from infra with { type: "runtime" }.`;
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
