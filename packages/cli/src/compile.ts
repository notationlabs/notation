import path from "node:path";
import {
  rolldown,
  watch as rolldownWatch,
  type InputOptions,
  type OutputOptions,
} from "rolldown";
import {
  infraEntry,
  infraEntryPlugin,
  infraPlugin,
  infraWatchExclude,
  ModuleAnalyses,
  runtimeEntry,
  runtimePlugin,
  type DeclarationModule,
} from "@notation/build";
import {
  filePaths,
  projectRoot,
  toProjectRoot,
  type Build,
} from "@notation/core";
import { defaultLogger, type Logger } from "./logger";

export type { DeclarationModule };

export type CompileOptions = {
  watch?: boolean;
  logger?: Logger;
};

/**
 * Compiles the infra entry, then bundles each declaration module that the
 * infra build found. In watch mode, each infra rebuild that changes that set
 * of modules restarts the runtime bundles. Returns a function that stops
 * watching.
 */
export async function compile(
  { entryPoint, files }: Build,
  opts: CompileOptions = {},
): Promise<() => Promise<void>> {
  const watch = opts.watch ?? false;
  const logger = opts.logger ?? defaultLogger;
  const analyses = new ModuleAnalyses({ files });

  logger.info(`${watch ? "Watching" : "Compiling"} infrastructure`, entryPoint);

  if (!watch) {
    const { modules } = await compileInfra(entryPoint, { analyses });
    logger.info("Compiling runtime modules");
    await compileRuntimeModules(modules, { analyses });
    return async () => {};
  }

  let modules: DeclarationModule[] | undefined;
  let disposeRuntime = async () => {};
  let updating = Promise.resolve();

  // Updates run one at a time, so two rebuilds never close the same
  // watcher.
  const update = (found: DeclarationModule[]) => {
    updating = updating.then(async () => {
      try {
        if (modules && sameModules(found, modules)) return;
        if (!modules) logger.info("Watching runtime modules");
        await disposeRuntime();
        disposeRuntime = async () => {};
        disposeRuntime = await compileRuntimeModules(found, {
          analyses,
          watch: true,
          onError: (error) => logger.error(error),
        });
        // Set only after a successful start, so that a failed start is
        // retried on the next rebuild with the same modules.
        modules = found;
      } catch (error) {
        logger.error(error);
      }
    });
  };

  // Deploys need a successful build, so watch waits until the first one.
  const infra = await compileInfra(entryPoint, {
    watch,
    analyses,
    onDeclarationModules: update,
    onBuildFailed: (error) => {
      logger.error(error);
      if (modules) return;
      logger.info(
        "The infrastructure build failed. Fix the errors above; watch starts deploying after the first build that succeeds.",
      );
    },
  });
  await updating;
  return async () => {
    await infra.close();
    await updating;
    await disposeRuntime();
  };
}

export type CompileInfraOptions = {
  watch?: boolean;
  /** Holds the kinds of the project's files. Defaults to the default globs. */
  analyses?: ModuleAnalyses;
  /**
   * Called after each build without errors, with the declaration modules in
   * the build. In watch mode this includes every rebuild.
   */
  onDeclarationModules?: (modules: DeclarationModule[]) => void;
  /** Called in watch mode for each build that fails. */
  onBuildFailed?: (error: unknown) => void;
};

/** The output name of a file under `dist`, without the extension. */
const outputName = (file: string) =>
  toProjectRoot(file).replace(/\.[cm]?[jt]sx?$/, "");

const outputOptions: OutputOptions = {
  dir: filePaths.dist.dir(),
  format: "esm",
  entryFileNames: "[name].mjs",
  chunkFileNames: "chunks/[name]-[hash].mjs",
};

/**
 * Bundles the infra entry to `dist/`. The bundle also imports each runtime
 * file, by the kinds in `analyses`, that holds a declaration, after the
 * entry.
 * Each declaration module in the build is replaced by its stripped copy.
 * Returns the declaration modules, sorted by path, and a function that stops
 * watching. In watch mode, resolves after the first build without errors.
 */
export async function compileInfra(
  entryPoint: string,
  opts: CompileInfraOptions = {},
): Promise<{ modules: DeclarationModule[]; close: () => Promise<void> }> {
  const analyses = opts.analyses ?? new ModuleAnalyses();
  let found: DeclarationModule[] = [];
  const root = projectRoot();
  const input: InputOptions = {
    input: { [outputName(entryPoint)]: infraEntry },
    cwd: root,
    platform: "node",
    tsconfig: true,
    plugins: [
      infraEntryPlugin({ analyses, entryPoint }),
      infraPlugin({
        analyses,
        onDeclarationModules: (modules) => {
          found = modules;
        },
      }),
    ],
  };
  // With source maps, a resource's declaredAt names the user's source file
  // and line, not the bundle's.
  const output: OutputOptions = {
    ...outputOptions,
    dir: filePaths.dist.dir(),
    sourcemap: true,
  };

  if (!opts.watch) {
    const bundle = await rolldown(input);
    try {
      await bundle.write(output);
    } finally {
      await bundle.close();
    }
    opts.onDeclarationModules?.(found);
    return { modules: found, close: async () => {} };
  }

  const watcher = rolldownWatch({
    ...input,
    output,
    // The infra entry plugin watches the base directory of each runtime
    // glob, which can be the project root.
    watch: { exclude: infraWatchExclude },
  });
  const close = () => watcher.close();
  return new Promise((resolve) => {
    watcher.on("event", async (event) => {
      if (event.code === "BUNDLE_END") {
        await event.result.close();
        opts.onDeclarationModules?.(found);
        resolve({ modules: found, close });
      }
      if (event.code === "ERROR") {
        await event.result.close();
        opts.onBuildFailed?.(event.error);
      }
    });
  });
}

export type CompileRuntimeOptions = {
  /** Holds the kinds of the project's files. Defaults to the default globs. */
  analyses?: ModuleAnalyses;
  watch?: boolean;
  /** Called in watch mode for each runtime build that fails. */
  onError?: (error: unknown) => void;
};

/**
 * Bundles each declaration module to `dist/<module path>/index.mjs`, as one
 * file. The bundle's entry is generated: it re-exports the module's entry,
 * such as `handler`. Returns a function that stops watching.
 */
export async function compileRuntimeModules(
  modules: DeclarationModule[],
  opts: CompileRuntimeOptions = {},
): Promise<() => Promise<void>> {
  if (modules.length === 0) return async () => {};
  const analyses = opts.analyses ?? new ModuleAnalyses();
  const distDir = filePaths.dist.dir();
  const configs = modules.map((module) => ({
    input: {
      input: {
        [path
          .relative(distDir, filePaths.dist.runtime.index(module.path))
          .replace(/\.mjs$/, "")]: runtimeEntry,
      },
      cwd: projectRoot(),
      platform: "node",
      tsconfig: true,
      resolve: {
        conditionNames: ["notation-runtime", "node", "import", "default"],
      },
      // Inlining would copy a short constant from an infra module into the
      // function, and the infra module would render nothing, so the bundle
      // check wouldn't see the use.
      optimization: { inlineConst: false },
      plugins: [runtimePlugin({ analyses, module })],
    } satisfies InputOptions,
    output: {
      ...outputOptions,
      dir: distDir,
      codeSplitting: false,
    } satisfies OutputOptions,
  }));

  if (!opts.watch) {
    await Promise.all(
      configs.map(async ({ input, output }) => {
        const bundle = await rolldown(input);
        try {
          await bundle.write(output);
        } finally {
          await bundle.close();
        }
      }),
    );
    return async () => {};
  }

  const watcher = rolldownWatch(
    configs.map(({ input, output }) => ({ ...input, output })),
  );
  await new Promise<void>((resolve) => {
    watcher.on("event", async (event) => {
      if (event.code === "BUNDLE_END") await event.result.close();
      if (event.code === "ERROR") {
        await event.result.close();
        opts.onError?.(event.error);
      }
      if (event.code === "END") resolve();
    });
  });
  return () => watcher.close();
}

function sameModules(a: DeclarationModule[], b: DeclarationModule[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
