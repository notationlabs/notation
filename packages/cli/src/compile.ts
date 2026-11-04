import path from "node:path";
import esbuild from "esbuild";
import {
  createRuntimeEntry,
  infraPlugin,
  type RuntimeModuleEntry,
} from "@notation/esbuild-plugins";
import {
  defaultRuntimeModules,
  filePaths,
  fromProjectRoot,
} from "@notation/core";
import { defaultLogger, type Logger } from "./logger";

export type { RuntimeModuleEntry };

export type CompileOptions = {
  watch?: boolean;
  logger?: Logger;
  /** Globs for the files that can be runtime modules. */
  runtimeModules?: string[];
};

/**
 * Compiles the infra entry, then bundles the runtime modules that the infra
 * build replaced. In watch mode, each infra rebuild that changes that set of
 * modules restarts the runtime bundles.
 */
export async function compile(entryPoint: string, opts: CompileOptions = {}) {
  const watch = opts.watch ?? false;
  const logger = opts.logger ?? defaultLogger;
  const runtimeModules = opts.runtimeModules ?? defaultRuntimeModules;

  logger.info(`${watch ? "Watching" : "Compiling"} infrastructure`, entryPoint);

  if (!watch) {
    const modules = await compileInfra(entryPoint, { runtimeModules });
    logger.info("Compiling runtime modules");
    await compileRuntimeModules(modules);
    return;
  }

  let modules: RuntimeModuleEntry[] | undefined;
  let disposeRuntime = async () => {};
  let updating = Promise.resolve();

  // Updates run one at a time, so two rebuilds never dispose the same
  // contexts.
  const update = (found: RuntimeModuleEntry[]) => {
    updating = updating.then(async () => {
      try {
        if (modules && sameModules(found, modules)) return;
        if (!modules) logger.info("Watching runtime modules");
        modules = found;
        await disposeRuntime();
        disposeRuntime = await compileRuntimeModules(found, true);
      } catch (error) {
        logger.error(error);
      }
    });
  };

  // Deploys need a successful build, so watch waits until the first one.
  await compileInfra(entryPoint, {
    watch,
    runtimeModules,
    onRuntimeModules: update,
    onBuildFailed: () => {
      if (modules) return;
      logger.info(
        "The infrastructure build failed. Fix the errors above; watch starts deploying after the first build that succeeds.",
      );
    },
  });
  await updating;
}

export type CompileInfraOptions = {
  watch?: boolean;
  runtimeModules?: string[];
  /**
   * Called after each build without errors, with the runtime modules that the
   * build replaced. In watch mode this includes every rebuild.
   */
  onRuntimeModules?: (modules: RuntimeModuleEntry[]) => void;
  onBuildFailed?: () => void;
};

/**
 * Bundles the infra entry to `dist/`. Returns the runtime modules that the
 * build replaced, sorted by path. In watch mode, resolves after the first
 * build without errors.
 */
export async function compileInfra(
  entryPoint: string,
  opts: CompileInfraOptions = {},
): Promise<RuntimeModuleEntry[]> {
  const runtimeModules = opts.runtimeModules ?? defaultRuntimeModules;
  let resolveFirst!: (modules: RuntimeModuleEntry[]) => void;
  const first = new Promise<RuntimeModuleEntry[]>((resolve) => {
    resolveFirst = resolve;
  });
  const onRuntimeModules = (modules: RuntimeModuleEntry[]) => {
    opts.onRuntimeModules?.(modules);
    resolveFirst(modules);
  };

  const context = await esbuild.context({
    entryPoints: [entryPoint],
    plugins: [
      infraPlugin({ runtimeModules, onRuntimeModules }),
      {
        name: "notation-build-failed",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) opts.onBuildFailed?.();
          });
        },
      },
    ],
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
    try {
      await context.rebuild();
    } finally {
      await context.dispose();
    }
  }
  return first;
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
  if (modules.length === 0) return async () => {};
  const distDir = filePaths.dist.dir();
  const entryPoints = Object.fromEntries(
    modules.map((module) => [
      path
        .relative(distDir, filePaths.dist.runtime.index(module.path))
        .replace(/\.mjs$/, ""),
      `${runtimeEntryNamespace}:${module.path}`,
    ]),
  );

  const context = await esbuild.context({
    entryPoints,
    plugins: [runtimeEntryPlugin(modules)],
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    treeShaking: true,
  });

  if (watch) {
    await context.watch();
  } else {
    try {
      await context.rebuild();
    } finally {
      await context.dispose();
    }
  }
  return () => context.dispose();
}

const runtimeEntryNamespace = "notation-runtime-entry";

// Serves the generated entry of each runtime module's bundle.
function runtimeEntryPlugin(modules: RuntimeModuleEntry[]): esbuild.Plugin {
  const services = new Map(
    modules.map((module) => [module.path, module.service]),
  );
  const prefix = `${runtimeEntryNamespace}:`;
  return {
    name: runtimeEntryNamespace,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${prefix}`) }, (args) => ({
        path: args.path.slice(prefix.length),
        namespace: runtimeEntryNamespace,
      }));
      build.onLoad(
        { filter: /.*/, namespace: runtimeEntryNamespace },
        (args) => ({
          contents: createRuntimeEntry(args.path, services.get(args.path)!),
          resolveDir: path.dirname(args.path),
          loader: "ts",
        }),
      );
    },
  };
}

function sameModules(a: RuntimeModuleEntry[], b: RuntimeModuleEntry[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
