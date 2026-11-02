import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { glob } from "glob";
import esbuild, { type BuildContext } from "esbuild";
import {
  createRuntimeEntry,
  infraPlugin,
  matchesRuntimeModules,
  parseRuntimeModule,
  runtimeModulesIgnore,
} from "@notation/esbuild-plugins";
import {
  defaultRuntimeModules,
  filePaths,
  fromProjectRoot,
  projectRoot,
  toProjectRoot,
} from "@notation/core";
import { defaultLogger, type Logger } from "./logger";

export type CompileOptions = {
  watch?: boolean;
  logger?: Logger;
  /** Globs for the files that can be runtime modules. */
  runtimeModules?: string[];
};

/** A module that matches the runtime-module globs and exports `resource`. */
export type RuntimeModuleEntry = {
  /** The absolute path of the module. */
  path: string;
  /** The module's `resource.service`, such as `aws/lambda`. */
  service: string;
};

export async function compile(entryPoint: string, opts: CompileOptions = {}) {
  const watch = opts.watch ?? false;
  const logger = opts.logger ?? defaultLogger;
  const runtimeModules = opts.runtimeModules ?? defaultRuntimeModules;

  logger.info(`${watch ? "Watching" : "Compiling"} infrastructure`, entryPoint);
  await compileInfra(entryPoint, { watch, runtimeModules });

  logger.info(`${watch ? "Watching" : "Compiling"} runtime modules`);
  let modules = await findRuntimeModules(runtimeModules);
  let disposeRuntime = await compileRuntimeModules(modules, watch);

  if (!watch) return;

  let updating = Promise.resolve();

  // esbuild watches the files each bundle imports. This watcher picks up
  // modules that start or stop being runtime modules.
  chokidar
    .watch(projectRoot(), {
      ignoreInitial: true,
      ignored: (file, stats) =>
        isIgnoredDir(file) ||
        (stats?.isFile() === true &&
          !matchesRuntimeModules(file, runtimeModules)),
    })
    .on("all", () => {
      // Updates run one at a time, so two events never dispose the same
      // contexts.
      updating = updating.then(async () => {
        try {
          const found = await findRuntimeModules(runtimeModules);
          if (sameModules(found, modules)) return;
          modules = found;
          await disposeRuntime();
          disposeRuntime = await compileRuntimeModules(modules, watch);
        } catch (error) {
          logger.error(error);
        }
      });
    });
}

export type CompileInfraOptions = {
  watch?: boolean;
  runtimeModules?: string[];
};

export async function compileInfra(
  entryPoint: string,
  opts: CompileInfraOptions = {},
) {
  const runtimeModules = opts.runtimeModules ?? defaultRuntimeModules;
  const context = await esbuild.context({
    entryPoints: [entryPoint],
    plugins: [infraPlugin({ runtimeModules })],
    outdir: filePaths.dist.dir(),
    outbase: fromProjectRoot("."),
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    treeShaking: true,
    packages: "external",
    // With source maps enabled, a resource's declaredAt names the user's
    // source file and line, not the bundle's.
    sourcemap: true,
  });

  if (opts.watch) {
    await context.watch();
  } else {
    await context.rebuild();
    await context.dispose();
  }
}

/**
 * Finds the runtime modules of the project: the files that match the globs
 * and export `resource`. Fails if a matching file still exports `config`.
 */
export async function findRuntimeModules(
  globs: string[] = defaultRuntimeModules,
): Promise<RuntimeModuleEntry[]> {
  const files = await glob(globs, {
    cwd: projectRoot(),
    ignore: runtimeModulesIgnore,
    nodir: true,
    absolute: true,
  });
  const modules: RuntimeModuleEntry[] = [];
  for (const file of files.sort()) {
    if (!matchesRuntimeModules(file, globs)) continue;
    const source = await fs.readFile(file, "utf8");
    const runtimeModule = parseRuntimeModule(source, toProjectRoot(file));
    if (runtimeModule) {
      modules.push({ path: file, service: runtimeModule.resource.service });
    }
  }
  return modules;
}

/**
 * Bundles each runtime module to `dist/<module path>/index.mjs`. The bundle's
 * entry is generated: its `handler` export dispatches each event to an export
 * of the module. Returns a function that stops watching.
 */
export async function compileRuntimeModules(
  modules: RuntimeModuleEntry[],
  watch: boolean = false,
) {
  const contexts: BuildContext[] = [];
  for (const module of modules) {
    const context = await esbuild.context({
      stdin: {
        contents: createRuntimeEntry(module.path, module.service),
        resolveDir: path.dirname(module.path),
        sourcefile: `${path.basename(module.path)}.entry.ts`,
        loader: "ts",
      },
      outfile: filePaths.dist.runtime.index(module.path),
      bundle: true,
      format: "esm",
      platform: "node",
      treeShaking: true,
    });

    if (watch) {
      await context.watch();
      contexts.push(context);
    } else {
      try {
        await context.rebuild();
      } finally {
        await context.dispose();
      }
    }
  }
  return async () => {
    await Promise.all(contexts.map((context) => context.dispose()));
  };
}

function sameModules(a: RuntimeModuleEntry[], b: RuntimeModuleEntry[]) {
  return (
    a.length === b.length &&
    a.every(
      (module, i) =>
        module.path === b[i]!.path && module.service === b[i]!.service,
    )
  );
}

function isIgnoredDir(file: string) {
  const relative = toProjectRoot(file);
  if (relative === "") return false;
  return (
    relative === "dist" ||
    relative.startsWith("dist/") ||
    relative
      .split("/")
      .some((part) => part === "node_modules" || part.startsWith("."))
  );
}
