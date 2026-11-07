import fs from "node:fs";
import path from "node:path";
import { projectRoot, toProjectRoot } from "@notation/core";
import type { Plugin } from "rolldown";
import { analyzeModule, type ModuleAnalysis } from "./analyze";
import { location } from "./ast";
import { stripForInfra, type DeclarationModule } from "./infra-strip";
import { Marks, type ImportBinding, type Mark } from "./marks";
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
function isInstalledPackage(
  source: string,
  importer: string,
  cache: Map<string, boolean>,
): boolean {
  const name = packageName(source);
  const key = `${path.dirname(importer)}\0${name}`;
  let installed = cache.get(key);
  if (installed === undefined) {
    installed = false;
    for (let dir = path.dirname(importer); ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "node_modules", name))) {
        installed = true;
        break;
      }
      if (dir === path.dirname(dir)) break;
    }
    cache.set(key, installed);
  }
  return installed;
}

// A file for an error message. A package file is named by its package, such
// as `@notation/aws/dist/sqs/index.js`. A workspace package resolves to its
// real path, so a path relative to the project root would read as
// `../../aws/dist/sqs/index.js`.
function displayPath(file: string): string {
  const relative = toProjectRoot(file);
  if (!nodeModules.test(file) && !relative.startsWith("..")) return relative;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const { name } = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (typeof name === "string") {
        return [name, ...path.relative(dir, file).split(path.sep)].join("/");
      }
    }
    if (dir === path.dirname(dir)) return relative;
  }
}

const envAdvice =
  "Read infra values in the function through the declaration's env().";

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

  /**
   * Analyses a module from the source that a transform hook sees. Each
   * runtime build transforms the same files, so an analysis of the same
   * source is reused.
   */
  fromSource(file: string, source: string): ModuleAnalysis {
    const cached = this.#analyses.get(file);
    if (cached?.table.module.source === source) return cached;
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
  // By importer directory and package name. Cleared on each build, so that
  // a package installed during watch is seen.
  const installed = new Map<string, boolean>();
  return {
    name: "notation-infra",
    buildStart() {
      installed.clear();
    },
    resolveId(source, importer) {
      if (
        !importer ||
        !isBareSpecifier(source) ||
        !isInstalledPackage(source, importer, installed)
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
        const stripped = stripForInfra(analysis, analyses.marks, projectRoot());
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
 * 4. Fails the build if an infra module, or an infra function from a
 *    package, is still in the bundle, and names the import chain.
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
          const uses = usesOfImports(
            output.modules,
            analyses,
            (binding, file) =>
              analyses.marks.resolve(binding.source, file) === id,
          );
          const chain = importChain(this, id).map(displayPath);
          this.error(
            `The bundle of ${toProjectRoot(module.path)} includes the infra module ${toProjectRoot(id)}, ${because(uses, chain)}. The runtime build leaves infra out, so runtime code can't use it. ${envAdvice}`,
          );
        }
        // Infra functions from packages, such as queue() from
        // @notation/aws/sqs. A package module can hold both infra and runtime
        // functions, so the check looks at the exports that are left after
        // tree-shaking.
        for (const [id, rendered] of Object.entries(output.modules)) {
          if (rendered.renderedLength === 0) continue;
          const code = this.getModuleInfo(id)?.code;
          if (!code || !/@resource|@declaration/.test(code)) continue;
          for (const name of rendered.renderedExports) {
            const mark = analyses.marks.exportMark(id, name);
            if (mark?.kind !== "resource" && mark?.kind !== "declaration")
              continue;
            const uses = usesOfImports(
              output.modules,
              analyses,
              (_binding, _file, importMark) =>
                importMark?.kind === "resource" ||
                importMark?.kind === "declaration",
            );
            const chain = importChain(this, id).map(displayPath);
            this.error(
              `The bundle of ${toProjectRoot(module.path)} includes a function that declares infrastructure, from ${displayPath(id)}, ${because(uses, chain)}. Infra functions can't run in a function. ${envAdvice}`,
            );
          }
        }
      }
    },
  };
}

type ImportUse = { at: string; name: string };

/**
 * The references in the bundle's project modules to imports that `matches`
 * accepts, as `file:line:column`. References in a declaration's options are
 * left out: the runtime strip removes them or has already checked them.
 * `importMark` is the mark of the imported function, if it has one.
 */
function usesOfImports(
  modules: Record<string, { renderedLength: number }>,
  analyses: ModuleAnalyses,
  matches: (binding: ImportBinding, file: string, importMark?: Mark) => boolean,
): ImportUse[] {
  const uses: ImportUse[] = [];
  for (const [file, rendered] of Object.entries(modules)) {
    if (rendered.renderedLength === 0) continue;
    const analysis = analyses.fromFile(file);
    if (!analysis) continue;
    const { table, declaration } = analysis;
    for (const { node, ancestors } of analysis.references) {
      const binding = table.imports.get(node.name);
      if (!binding) continue;
      if (
        declaration &&
        node.start >= declaration.call.start &&
        node.end <= declaration.call.end
      )
        continue;
      let name = node.name;
      let member: string | undefined;
      const parent = ancestors.at(-1);
      if (
        binding.imported === "*" &&
        parent?.type === "MemberExpression" &&
        !parent.computed &&
        parent.object === node
      ) {
        member = parent.property.name;
        name = `${node.name}.${member}`;
      }
      const importMark = analyses.marks.importMark(
        file,
        binding,
        undefined,
        member,
      );
      if (!matches(binding, file, importMark)) continue;
      uses.push({
        at: `${toProjectRoot(file)}:${location(table.module.source, node.start)}`,
        name,
      });
    }
  }
  return uses;
}

// Why a module is in the bundle: the references that use it, or else the
// chain of imports that brings it in.
function because(uses: ImportUse[], chain: string[]): string {
  if (uses.length === 0) return `imported through ${chain.join(" → ")}`;
  const listed = uses.map(({ at, name }) => `${name} at ${at}`);
  return `because the function uses ${listed.join(", ")}`;
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
