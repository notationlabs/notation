import path from "node:path";
import chokidar from "chokidar";
import { glob } from "glob";
import esbuild from "esbuild";
import {
  functionInfraPlugin,
  functionRuntimePlugin,
} from "@notation/esbuild-plugins";
import { filePaths, type Project } from "@notation/core";
import { defaultLogger, type Logger } from "./logger";

export type CompileOptions = {
  watch?: boolean;
  logger?: Logger;
};

export async function compile(
  project: Project,
  entryPoint: string,
  opts: CompileOptions = {},
) {
  const watch = opts.watch ?? false;
  const logger = opts.logger ?? defaultLogger;

  logger.info(`${watch ? "Watching" : "Compiling"} infrastructure`, entryPoint);
  await compileInfra(project, entryPoint, watch);

  logger.info(`${watch ? "Watching" : "Compiling"} functions`);

  // @todo: fnEntryPoints could be an output of compileInfra
  const fnEntryPoints = await glob(
    path.join(project.root, "runtime/**/*.fn.ts"),
  );
  let disposeFnCompiler = await compileFns(fnEntryPoints, watch);

  if (!watch) return;

  chokidar
    .watch("**/*.fn.ts", {
      cwd: project.root,
      ignored: /node_modules/,
      persistent: true,
    })
    .on("all", async () => {
      if (disposeFnCompiler) disposeFnCompiler();
      const fnEntryPoints = await glob(
        path.join(project.root, "runtime/**/*.fn.ts"),
      );
      disposeFnCompiler = await compileFns(fnEntryPoints, watch);
    });
}

export async function compileInfra(
  project: Project,
  entryPoint: string,
  watch: boolean = false,
) {
  const context = await esbuild.context({
    entryPoints: [entryPoint],
    plugins: [functionInfraPlugin()],
    outdir: filePaths.dist.dir(),
    outbase: project.root,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    treeShaking: true,
    packages: "external",
  });

  if (watch) {
    await context.watch();
  } else {
    await context.rebuild();
    context.dispose();
  }
}

export async function compileFns(
  entryPoints: string[],
  watch: boolean = false,
) {
  for (const entryPoint of entryPoints) {
    const context = await esbuild.context({
      entryPoints: [entryPoint],
      plugins: [functionRuntimePlugin()],
      outfile: filePaths.dist.runtime.index(entryPoint),
      outExtension: { ".js": ".mjs" },
      bundle: true,
      format: "esm",
      platform: "node",
      treeShaking: true,
    });

    if (watch) {
      await context.watch();
      return () => context.dispose();
    } else {
      await context.rebuild();
      context.dispose();
    }
  }
}
