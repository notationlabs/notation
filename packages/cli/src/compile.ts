import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import {
  createFunctionEntry,
  infraPlugin,
  resolveRuntimeLink,
  runtimePlugin,
} from "@notation/esbuild-plugins";
import {
  defaultRuntimeModules,
  filePaths,
  fromProjectRoot,
  projectRoot,
  type Build,
} from "@notation/core";
import type { RuntimeFunction } from "@notation/resource";
import { defaultLogger, type Logger } from "./logger";

export type { RuntimeFunction };

export type CompileOptions = {
  watch?: boolean;
  logger?: Logger;
};

/**
 * Builds in the order that declaring functions needs:
 *
 * 1. Bundle and evaluate the infra phase, which declares the functions and
 *    links each handler to its function.
 * 2. Bundle each function, with its handlers as the dispatch entry, and list
 *    the values that each bundle reads from infra. Plan and deploy deliver
 *    them.
 *
 * In watch mode, each infra rebuild is evaluated again, and a change to the
 * functions or their handlers restarts the function bundles.
 */
export async function compile(
  { entryPoint, runtimeModules }: Build,
  opts: CompileOptions = {},
) {
  const watch = opts.watch ?? false;
  const logger = opts.logger ?? defaultLogger;

  logger.info(`${watch ? "Watching" : "Compiling"} infrastructure`, entryPoint);

  if (!watch) {
    await compileInfra(entryPoint, { runtimeModules, logger });
    const functions = await evaluateFunctions(entryPoint);
    logger.info("Compiling functions");
    await compileFunctions(functions);
    return;
  }

  let functions: RuntimeFunction[] | undefined;
  let disposeFunctions = async () => {};
  let updating = Promise.resolve();

  // Updates run one at a time, so two rebuilds never dispose the same
  // contexts.
  const update = () => {
    updating = updating.then(async () => {
      try {
        const found = await evaluateFunctions(entryPoint);
        if (functions && sameFunctions(found, functions)) return;
        if (!functions) logger.info("Watching functions");
        await disposeFunctions();
        disposeFunctions = async () => {};
        disposeFunctions = await compileFunctions(found, true);
        // Set only after a successful start, so that a failed start is
        // retried on the next rebuild with the same functions.
        functions = found;
      } catch (error) {
        logger.error(error);
      }
    });
  };

  // Deploys need a successful build, so watch waits until the first one.
  await compileInfra(entryPoint, {
    watch,
    runtimeModules,
    logger,
    onRuntimeModules: update,
    onBuildFailed: () => {
      if (functions) return;
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
   * Called after each build without errors, with the absolute paths of the
   * runtime modules that infra imports. In watch mode this includes every
   * rebuild.
   */
  onRuntimeModules?: (modules: string[]) => void;
  onBuildFailed?: () => void;
  /** Logs the build's warnings, such as a runtime module that isn't wired. */
  logger?: Logger;
};

/**
 * Bundles the infra phase to `dist/`. Returns the runtime modules that infra
 * imports, sorted by path. In watch mode, resolves after the first build
 * without errors.
 */
export async function compileInfra(
  entryPoint: string,
  opts: CompileInfraOptions = {},
): Promise<string[]> {
  const runtimeModules = opts.runtimeModules ?? defaultRuntimeModules;
  const logger = opts.logger ?? defaultLogger;
  // In watch mode, a warning is logged again only after a build without it.
  let warned = new Set<string>();
  let resolveFirst!: (modules: string[]) => void;
  const first = new Promise<string[]>((resolve) => {
    resolveFirst = resolve;
  });
  const onRuntimeModules = (modules: string[]) => {
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
          // The infra plugin scans infra with a build that doesn't write.
          if (build.initialOptions.write === false) return;
          build.onEnd((result) => {
            if (result.errors.length > 0) opts.onBuildFailed?.();
            const warnings = new Set(result.warnings.map((w) => w.text));
            for (const text of warnings) {
              if (!warned.has(text)) logger.warn(text);
            }
            warned = warnings;
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

const functionsMarker = "__notation_functions__";

/**
 * Evaluates the infra bundle and returns the functions that runtime modules
 * declared, with their handlers. It runs in a child process, so that the
 * bundle and its module cache don't stay in this process.
 */
export async function evaluateFunctions(
  entryPoint: string,
): Promise<RuntimeFunction[]> {
  const bundle = filePaths.dist.infra(entryPoint);
  const script = `
    import { collectResourceGraph } from ${JSON.stringify(resolveRuntimeLink())};
    const graph = await collectResourceGraph(
      () => import(${JSON.stringify(`${pathToFileURL(bundle).href}?${Date.now()}`)}),
      { declarationChecks: false },
    );
    console.log(${JSON.stringify(functionsMarker)} + JSON.stringify(graph.runtimeFunctions));
  `;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--enable-source-maps", "--input-type=module", "-e", script],
      { cwd: projectRoot(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Evaluating the infrastructure failed:\n${stderr.trim() || error.message}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
  const line = stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(functionsMarker));
  if (!line) {
    throw new Error("Evaluating the infrastructure returned no functions.");
  }
  return JSON.parse(line.slice(functionsMarker.length));
}

/**
 * Bundles each function to its `bundle` path. The bundle's entry is
 * generated: its `handler` export dispatches each event to one of the
 * function's handlers. The output keys that each bundle reads from infra go
 * in `reads.json` next to it. Returns a function that stops watching.
 */
export async function compileFunctions(
  functions: RuntimeFunction[],
  watch: boolean = false,
) {
  if (functions.length === 0) return async () => {};
  const distDir = filePaths.dist.dir();
  const entryPoints = Object.fromEntries(
    functions.map((fn) => [
      path
        .relative(distDir, fromProjectRoot(fn.bundle))
        .split(path.sep)
        .join("/")
        .replace(/\.mjs$/, ""),
      `${functionEntryNamespace}:${fn.id}`,
    ]),
  );

  const context = await esbuild.context({
    entryPoints,
    plugins: [
      functionEntryPlugin(functions),
      runtimePlugin({ onReads: (reads) => writeReads(functions, reads) }),
    ],
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

// Lists the reads of each function's bundle next to it, where plan and
// deploy find them.
function writeReads(
  functions: RuntimeFunction[],
  reads: Record<string, string[]>,
) {
  for (const fn of functions) {
    const file = filePaths.dist.reads(fn.bundle);
    mkdirSync(path.dirname(file), { recursive: true });
    const found = reads[fromProjectRoot(fn.bundle)] ?? [];
    writeFileSync(file, `${JSON.stringify({ reads: found }, null, 2)}\n`);
  }
}

const functionEntryNamespace = "notation-function-entry";

function functionEntryPlugin(functions: RuntimeFunction[]): esbuild.Plugin {
  const byId = new Map(functions.map((fn) => [fn.id, fn]));
  const prefix = `${functionEntryNamespace}:`;
  return {
    name: functionEntryNamespace,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${prefix}`) }, (args) => ({
        path: args.path.slice(prefix.length),
        namespace: functionEntryNamespace,
      }));
      build.onLoad(
        { filter: /.*/, namespace: functionEntryNamespace },
        (args) => ({
          contents: createFunctionEntry(byId.get(args.path)!, fromProjectRoot),
          resolveDir: projectRoot(),
          loader: "js",
        }),
      );
    },
  };
}

function sameFunctions(a: RuntimeFunction[], b: RuntimeFunction[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
