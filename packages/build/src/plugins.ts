import fs from "node:fs";
import path from "node:path";
import { projectRoot, toProjectRoot } from "@notation/core";
import type { Plugin } from "rolldown";
import type { ModuleAnalysis } from "./analyze";
import { location } from "./ast";
import {
  infraInterface,
  stripForInfra,
  type DeclarationModule,
} from "./infra-strip";
import type { ImportBinding, Mark } from "./marks";
import {
  displayPath,
  ModuleAnalyses,
  nodeModules,
  scriptFile,
} from "./modules";
import { stripForRuntime } from "./runtime-strip";

export { ModuleAnalyses };

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

// A quick test that skips modules which can't hold a declaration, or import
// a resource function, an infra module or a runtime module: those need an
// import, a re-export or a local mark.
const mayHoldMarks = (code: string) =>
  /\bimport\b|\bfrom\b|@declaration|@resource/.test(code);

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
        if (!analyses.isProjectModule(id)) return null;
        declarations.delete(id);
        if (!mayHoldMarks(code)) return null;
        const analysis = analyses.fromSource(id, code);
        analyses.checkShared(id);
        checkRuntimeImports(analysis, analyses);
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

// Fails if the infra copy of a module imports a name from a runtime module
// that the runtime module's infra copy doesn't keep. Rolldown would report
// a missing export, which doesn't say why the export is missing.
function checkRuntimeImports(
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
) {
  const { table } = analysis;
  const file = table.module.file;
  const kept = analysis.declaration ? infraInterface(analysis) : undefined;
  const imported: { source: string; name: string }[] = [];
  for (const [local, binding] of table.imports) {
    if (kept && !kept.imports.has(local)) continue;
    imported.push({ source: binding.source, name: binding.imported });
  }
  // A declaration module's infra copy drops its re-exports.
  if (!kept) {
    for (const target of table.exports.values()) {
      if ("source" in target) {
        imported.push({ source: target.source, name: target.imported });
      }
    }
  }
  for (const { source, name } of imported) {
    if (name === "*") continue;
    const resolved = analyses.marks.resolve(source, file);
    if (!resolved) continue;
    const target = analyses.fromFile(resolved);
    if (!target?.declaration) continue;
    if (infraInterface(target).exports.has(name)) continue;
    throw new Error(
      `Illegal import: ${displayPath(file)} imports ${name} from a runtime module, ${displayPath(resolved)}. Move ${name} to a shared module.`,
    );
  }
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
  const describeInfra = (file: string) =>
    analyses.kind(file)?.kind === "infra"
      ? { module: displayPath(file), reason: analyses.describeKind(file)! }
      : undefined;
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
        if (!analyses.isProjectModule(id)) return null;
        infraModules.delete(id);
        if (!mayHoldMarks(code)) return null;
        const analysis = analyses.fromSource(id, code);
        analyses.checkShared(id);
        const isInfra = analyses.kind(id)?.kind === "infra";
        if (isInfra) infraModules.add(id);
        const stripped = stripForRuntime(
          analysis,
          analyses.marks,
          describeInfra,
        );
        if (!stripped && !isInfra) return null;
        return {
          code: stripped?.code ?? code,
          map: stripped?.map,
          moduleSideEffects: isInfra ? false : undefined,
        };
      },
    },
    watchChange(id) {
      analyses.invalidate(id);
    },
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        // Of the infra modules left in the bundle, the error names the one
        // closest to the entry.
        const [left] = [...infraModules]
          .filter((id) => (output.modules[id]?.renderedLength ?? 0) > 0)
          .map((id) => ({ id, chain: importChain(this, id) }))
          .sort((a, b) => a.chain.length - b.chain.length);
        if (left) {
          const { id } = left;
          const uses = usesOfImports(
            output.modules,
            analyses,
            (binding, file) =>
              analyses.marks.resolve(binding.source, file) === id,
          );
          const chain = left.chain.map((file) => displayPath(file));
          this.error(
            `The bundle of ${toProjectRoot(module.path)} includes the infra module ${toProjectRoot(id)}. ${because(uses, chain)} ${toProjectRoot(id)} is ${analyses.describeKind(id)}. The runtime build leaves infra modules out, so runtime code can't use them. Read infra values through the declaration's env(), and move code that both builds need to a shared module.`,
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
            const chain = importChain(this, id).map((file) =>
              displayPath(file),
            );
            this.error(
              `The bundle of ${toProjectRoot(module.path)} includes ${name} from ${displayPath(id)}, a function that declares infrastructure. ${because(uses, chain)} Infra functions can't run in a runtime module.`,
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

// Why a module is in the bundle: the chain of imports that brings it in, and
// the references that use it.
function because(uses: ImportUse[], chain: string[]): string {
  const imported = `The bundle imports it through ${chain.join(" → ")}`;
  if (uses.length === 0) return `${imported}.`;
  const listed = uses.map(({ at, name }) => `${name} at ${at}`);
  return `${imported}, and uses ${listed.join(", ")}.`;
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
