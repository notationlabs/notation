import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "rolldown";
import type { ModuleAnalysis } from "./analyze";
import { location, parseModule } from "./ast";
import { nodeModules, scriptFile } from "./files";
import { runtimeExports } from "./exports";
import {
  checkProvidedUses,
  infraInterface,
  ProvidedRemovals,
  stripForInfra,
  stripProvided,
  type DeclarationModule,
} from "./infra-strip";
import type { ImportBinding, Mark } from "./marks";
import { isProjectModule, type ModuleAnalyses } from "./modules";
import { describeProvided, providerOfModule } from "./platforms";
import { stripForRuntime } from "./runtime-strip";

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

// A quick test that skips modules which can't hold a declaration or call a
// resource function, or import from a runtime module: those need an import,
// a re-export or a local mark.
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
  const removals = new ProvidedRemovals(analyses);
  // By importer directory and package name. Cleared on each build, so that
  // a package installed during watch is seen.
  const installed = new Map<string, boolean>();
  return {
    name: "notation-infra",
    buildStart() {
      installed.clear();
      removals.clear();
    },
    resolveId(source, importer) {
      // `source` is a module that only another platform provides. The
      // transform removes static imports of it. A dynamic import or
      // `export * from` stays, and is marked external here.
      if (importer && providerOfModule(source)) {
        return { id: source, external: true, moduleSideEffects: false };
      }
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
        analyses.checkDeclaration(id, analysis);
        checkRuntimeImports(analysis, analyses);
        const removal = removals.of(id);
        if (removal) analyses.checkSharedPlatformUse(id, removal);
        if (!analysis.declaration) {
          return (removal && stripProvided(analysis, removal)) ?? null;
        }
        if (removal) {
          checkProvidedUses(analysis, removal, (file) => analyses.show(file));
        }
        const stripped = stripForInfra(
          analysis,
          analyses.marks,
          analyses.files.root,
        );
        declarations.set(id, stripped.declaration);
        return { code: stripped.code, map: stripped.map };
      },
    },
    watchChange(id) {
      analyses.invalidate(id);
      removals.clear();
    },
    buildEnd(error) {
      if (error) return;
      for (const id of this.getModuleIds()) analyses.checkShared(id);
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const source = keptStaticImport(chunk.fileName, chunk.code);
        if (!source) continue;
        const importer = Object.keys(chunk.modules).find((id) =>
          this.getModuleInfo(id)?.importedIds.includes(source),
        );
        throw new Error(
          `${importer ? analyses.show(importer) : chunk.fileName} imports ${describeProvided(source)}, and code that runs at deploy uses it. Move the code that runs at deploy to a file that doesn't import ${source}.`,
        );
      }
      if (!onDeclarationModules) return;
      const ids = new Set(this.getModuleIds());
      const found = [...declarations.values()]
        .filter((module) => ids.has(module.path))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      onDeclarationModules(found);
    },
  };
}

// Finds a static import of a module that only another platform provides.
// Parses the code, because `chunk.imports` also lists imports that tree
// shaking removed. A dynamic import only fails if it runs, so it is allowed.
function keptStaticImport(file: string, code: string): string | undefined {
  for (const node of parseModule(file, code).body) {
    if (node.type !== "ImportDeclaration") continue;
    const source: string = node.source.value;
    if (providerOfModule(source)) return source;
  }
  return undefined;
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
      `Illegal import: ${analyses.show(file)} imports ${name} from a runtime module, ${analyses.show(resolved)}. Move ${name} to a shared module.`,
    );
  }
}

const entryId = "notation:runtime-entry";
const resolvedEntryId = `\0${entryId}`;

/** The input to give a runtime build that uses `runtimePlugin`. */
export const runtimeEntry = entryId;

/**
 * Returns the source of the entry file of a function's bundle, such as
 * `export { handler } from "/project/runtime/todos.ts"`. Exported for tests.
 */
export function createRuntimeEntry(file: string, names: string[]): string {
  const show = (name: string) =>
    /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  return `export { ${names.map(show).join(", ")} } from ${JSON.stringify(file)};\n`;
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
 * 3. Marks the modules that `files.infra` matches free of side effects, so
 *    the bundler drops each one whose bindings are no longer used.
 * 4. Fails the build if an infra module, or an infra function from a
 *    package, is still in the bundle, and names the import chain.
 * 5. Fails the build if a shared module in the bundle breaks its rules.
 *
 * The build's input options must set `optimization: { inlineConst: false }`.
 * Otherwise the bundler copies a short constant, such as `"eu"`, from an
 * infra module into the code that uses it. The infra module then renders
 * nothing, and step 4 doesn't see the use.
 */
export function runtimePlugin({
  analyses,
  module,
}: RuntimePluginOptions): Plugin {
  const infraModules = new Set<string>();
  return {
    name: "notation-runtime",
    resolveId(source) {
      return source === entryId ? resolvedEntryId : null;
    },
    load(id) {
      if (id !== resolvedEntryId) return null;
      // Reads the module from disk. In watch mode this runs before the infra
      // rebuild, so the cached analysis can be stale.
      const analysis = analyses.fromDisk(module.path);
      const exports = analysis && runtimeExports(analysis);
      if (!exports || !analyses.marks.hasExport(module.path, exports.entry)) {
        return "export {};\n";
      }
      return createRuntimeEntry(module.path, [
        exports.entry,
        ...exports.others,
      ]);
    },
    transform: {
      filter: { id: { include: scriptFile, exclude: nodeModules } },
      handler(code, id) {
        if (!isProjectModule(id)) return null;
        if (analyses.files.kindOf(id)?.kind === "infra") {
          infraModules.add(id);
          return { code, moduleSideEffects: false };
        }
        if (!mayHoldMarks(code)) return null;
        return stripForRuntime(analyses.fromSource(id, code), analyses) ?? null;
      },
    },
    watchChange(id) {
      analyses.invalidate(id);
    },
    buildEnd(error) {
      if (error) return;
      for (const id of this.getModuleIds()) analyses.checkShared(id);
    },
    generateBundle(_, bundle) {
      // An entry with no exports means that the module no longer declares a
      // function. The build writes nothing, and the infra build either fails
      // or stops bundling the module.
      const entry = Object.values(bundle).find(
        (output) => output.type === "chunk" && output.isEntry,
      );
      if (entry?.type === "chunk" && entry.exports.length === 0) {
        for (const fileName of Object.keys(bundle)) delete bundle[fileName];
        return;
      }
      const show = (file: string) => analyses.show(file);
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
          const chain = importChain(this, id).map(show);
          this.error(
            `The function in ${show(module.path)} uses ${analyses.describeInfra(id)}${listUses(uses)}. It imports ${show(id)} through ${chain.join(" → ")}. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).`,
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
            // Marks are cached per module, so an import of this export,
            // through any re-export or alias, has the same mark object.
            const uses = usesOfImports(
              output.modules,
              analyses,
              (_binding, _file, importMark) => importMark === mark,
            );
            const chain = importChain(this, id);
            const unmatched = chain
              .map((file) => analyses.resourceCallAdvice(file))
              .find(Boolean);
            this.error(
              `The function in ${show(module.path)} uses ${name} from ${show(id)}, a function that declares infrastructure${listUses(uses)}. It imports ${show(id)} through ${chain.map(show).join(" → ")}. Infra functions can't run in a runtime module.${unmatched ? ` ${unmatched}` : ""}`,
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
        at: `${analyses.show(file)}:${location(table.module.source, node.start)}`,
        name,
      });
    }
  }
  return uses;
}

// The uses that the bundle check names, as `: name at file:line:column, ...`.
function listUses(uses: ImportUse[]): string {
  if (uses.length === 0) return "";
  return `: ${uses.map(({ at, name }) => `${name} at ${at}`).join(", ")}`;
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
