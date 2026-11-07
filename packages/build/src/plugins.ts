import fs from "node:fs";
import path from "node:path";
import { toProjectRoot } from "@notation/core";
import type { Plugin } from "rolldown";
import { analyzeModule, type ModuleAnalysis } from "./analyze";
import { stripForInfra, type DeclarationModule } from "./infra-strip";
import { Marks } from "./marks";
import { stripForRuntime } from "./runtime-strip";

const nodeModules = /[\\/]node_modules[\\/]/;
const scriptFile = /\.[cm]?[jt]sx?$/;

// The modules that the strips read: the project's own JS and TS files.
const isProjectModule = (id: string) =>
  !id.startsWith("\0") && scriptFile.test(id) && !nodeModules.test(id);

const isBareSpecifier = (source: string) =>
  !source.startsWith(".") &&
  !source.startsWith("/") &&
  !source.startsWith("\0") &&
  !/^[A-Za-z]:[\\/]/.test(source);

// The package name of a bare specifier, such as `@notation/aws` for
// `@notation/aws/lambda`.
const packageName = (source: string) =>
  source
    .split("/")
    .slice(0, source.startsWith("@") ? 2 : 1)
    .join("/");

// Whether a bare specifier names an installed package, as opposed to a path
// alias from tsconfig. Workspace packages are symlinks into the repository,
// so the resolved path doesn't tell them apart from project files.
function isInstalledPackage(source: string, importer: string): boolean {
  const name = packageName(source);
  for (let dir = path.dirname(importer); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules", name))) return true;
    if (dir === path.dirname(dir)) return false;
  }
}

/**
 * Analyses project modules for both builds. An analysis is kept until its
 * file changes.
 */
export class ModuleAnalyses {
  readonly marks: Marks;
  #analyses = new Map<string, ModuleAnalysis>();

  constructor(marks: Marks = new Marks()) {
    this.marks = marks;
  }

  /** Analyses a module from the source that a transform hook sees. */
  fromSource(file: string, source: string): ModuleAnalysis {
    const analysis = analyzeModule(
      this.marks.setSource(file, source),
      this.marks,
    );
    this.#analyses.set(file, analysis);
    return analysis;
  }

  /** Analyses a module from the file system. */
  fromFile(file: string): ModuleAnalysis | undefined {
    if (!isProjectModule(file)) return undefined;
    let analysis = this.#analyses.get(file);
    if (!analysis) {
      const table = this.marks.table(file);
      if (!table) return undefined;
      analysis = analyzeModule(table, this.marks);
      this.#analyses.set(file, analysis);
    }
    return analysis;
  }

  invalidate(file: string) {
    this.#analyses.delete(file);
    this.marks.invalidate(file);
  }
}

// A quick test that skips modules which can't hold a declaration or call a
// resource function: those need an import or a local mark.
const mayHoldMarks = (code: string) =>
  /\bimport\b|@declaration|@resource/.test(code);

export type InfraPluginOptions = {
  analyses: ModuleAnalyses;
  /**
   * Called after each build that produces output, with the declaration
   * modules in the build, sorted by path.
   */
  onDeclarationModules?: (modules: DeclarationModule[]) => void;
};

/**
 * The infra build's plugin. Replaces each declaration module with its
 * stripped copy, and leaves packages external, so that the infra bundle
 * imports them from the project's node_modules.
 */
export function infraPlugin({
  analyses,
  onDeclarationModules,
}: InfraPluginOptions): Plugin {
  const declarations = new Map<string, DeclarationModule>();
  return {
    name: "notation-infra",
    resolveId(source, importer) {
      if (
        !importer ||
        !isBareSpecifier(source) ||
        !isInstalledPackage(source, importer)
      )
        return null;
      return { id: source, external: true };
    },
    transform: {
      filter: { id: { include: scriptFile, exclude: nodeModules } },
      handler(code, id) {
        if (!isProjectModule(id)) return null;
        declarations.delete(id);
        if (!mayHoldMarks(code)) return null;
        const analysis = analyses.fromSource(id, code);
        if (!analysis.declaration) return null;
        const stripped = stripForInfra(analysis);
        declarations.set(id, stripped.declaration);
        return { code: stripped.code, map: stripped.map };
      },
    },
    watchChange(id) {
      analyses.invalidate(id);
    },
    generateBundle() {
      if (!onDeclarationModules) return;
      const ids = new Set(this.getModuleIds());
      const found = [...declarations.values()]
        .filter((module) => ids.has(module.path))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      onDeclarationModules(found);
    },
  };
}

const entryId = "notation:runtime-entry";
const resolvedEntryId = `\0${entryId}`;

/** The input to give a runtime build that uses `runtimePlugin`. */
export const runtimeEntry = entryId;

/**
 * The entry of a runtime bundle. It re-exports only the native entry, such as
 * `handler`, so the declaration is not an export of the bundle, and the
 * bundler can drop it.
 */
export function createRuntimeEntry(module: DeclarationModule): string {
  const from = JSON.stringify(module.path);
  return module.entry === "default"
    ? `export { default } from ${from};\n`
    : `export { ${module.entry} } from ${from};\n`;
}

export type RuntimePluginOptions = {
  analyses: ModuleAnalyses;
  module: DeclarationModule;
};

/**
 * The runtime build's plugin, for the bundle of one declaration module.
 *
 * 1. Serves the generated entry.
 * 2. Reduces each declaration to its runtime options.
 * 3. Marks infra modules free of side effects, so the bundler drops each one
 *    whose bindings are no longer used.
 * 4. Fails the build if an infra module is still in the bundle, and names the
 *    import chain.
 */
export function runtimePlugin({
  analyses,
  module,
}: RuntimePluginOptions): Plugin {
  const infraModules = new Set<string>();
  const isInfraModule = (file: string) =>
    analyses.fromFile(file)?.isInfra ?? false;
  return {
    name: "notation-runtime",
    resolveId(source) {
      return source === entryId ? resolvedEntryId : null;
    },
    load(id) {
      return id === resolvedEntryId ? createRuntimeEntry(module) : null;
    },
    transform: {
      filter: { id: { include: scriptFile, exclude: nodeModules } },
      handler(code, id) {
        if (!isProjectModule(id)) return null;
        infraModules.delete(id);
        if (!mayHoldMarks(code)) return null;
        const analysis = analyses.fromSource(id, code);
        if (analysis.isInfra) infraModules.add(id);
        const stripped = stripForRuntime(
          analysis,
          analyses.marks,
          isInfraModule,
        );
        if (!stripped && !analysis.isInfra) return null;
        return {
          code: stripped?.code ?? code,
          map: stripped?.map,
          moduleSideEffects: analysis.isInfra ? false : undefined,
        };
      },
    },
    watchChange(id) {
      analyses.invalidate(id);
    },
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of infraModules) {
          const rendered = output.modules[id];
          if (!rendered || rendered.renderedLength === 0) continue;
          const chain = importChain(this, id).map((file) =>
            toProjectRoot(file),
          );
          this.error(
            `The bundle of ${toProjectRoot(module.path)} includes the infra module ${toProjectRoot(id)}, imported through ${chain.join(" → ")}. The runtime build leaves infra out, so runtime code can't use it. Read infra values in the function through the declaration's env().`,
          );
        }
      }
    },
  };
}

type ModuleGraph = {
  getModuleInfo(id: string): { importedIds: readonly string[] } | null;
};

// The shortest chain of imports from the entry to `target`, without the
// generated entry.
function importChain(graph: ModuleGraph, target: string): string[] {
  const previous = new Map<string, string | undefined>([
    [resolvedEntryId, undefined],
  ]);
  const queue = [resolvedEntryId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === target) break;
    for (const next of graph.getModuleInfo(id)?.importedIds ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, id);
      queue.push(next);
    }
  }
  const chain: string[] = [];
  for (
    let id: string | undefined = target;
    id && id !== resolvedEntryId;
    id = previous.get(id)
  ) {
    chain.unshift(id);
  }
  return chain;
}
