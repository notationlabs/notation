import path from "node:path";
import esbuild, { type BuildContext } from "esbuild";
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
  const contexts: BuildContext[] = [];
  const results = await Promise.allSettled(
    modules.map(async (module) => {
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
        contexts.push(context);
        await context.watch();
      } else {
        try {
          await context.rebuild();
        } finally {
          await context.dispose();
        }
      }
    }),
  );

  const dispose = async () => {
    await Promise.all(contexts.map((context) => context.dispose()));
  };
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    await dispose();
    throw failure.reason;
  }
  return dispose;
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
