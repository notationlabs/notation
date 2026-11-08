import fs from "node:fs";
import path from "node:path";
import type { ModuleGlobs } from "@notation/core";
import { analyzeModule, type ModuleAnalysis } from "./analyze";
import { location, type Node } from "./ast";
import {
  describeKind,
  FileKinds,
  nodeModules,
  scriptFile,
  type KindMatch,
} from "./files";
import { Marks } from "./marks";

// The modules that the strips read: JS and TS files outside node_modules.
// These include files of workspace packages, which resolve to their real
// path.
export const isProjectModule = (id: string) =>
  !id.startsWith("\0") && scriptFile.test(id) && !nodeModules.test(id);

/**
 * A file for an error message. A package file is named by its package, such
 * as `@notation/aws/dist/sqs/index.js`. A workspace package resolves to its
 * real path, so a path relative to the project root would read as
 * `../../aws/dist/sqs/index.js`.
 */
export function displayPath(file: string, root: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
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

export type ModuleAnalysesOptions = {
  marks?: Marks;
  /** The kinds of the project's files, or the globs of `files` to read them from. */
  files?: FileKinds | ModuleGlobs;
};

// An import that the walk of `checkShared` follows, and the import before
// it.
type Step = { file: string; start: number; previous?: Step };

/**
 * Analyses project modules for both builds, and gives each one its kind. An
 * analysis is kept until its file changes.
 */
export class ModuleAnalyses {
  readonly marks: Marks;
  readonly files: FileKinds;
  #analyses = new Map<string, ModuleAnalysis>();

  constructor(options: ModuleAnalysesOptions = {}) {
    this.marks = options.marks ?? new Marks();
    this.files =
      options.files instanceof FileKinds
        ? options.files
        : new FileKinds(options.files);
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

  /** A file for an error message, relative to the project root. */
  show(file: string): string {
    return displayPath(file, this.files.root);
  }

  /** The kind of a JS or TS file of the project. */
  kindOf(file: string): KindMatch | undefined {
    return isProjectModule(file) ? this.files.kindOf(file) : undefined;
  }

  /**
   * If a file is an infra module, says why, for an error message. A project
   * file is infra if `files.infra` matches it. A package file outside
   * `node_modules` has no kind, so it is infra if it calls a resource
   * function at its top level.
   */
  describeInfra(file: string): string | undefined {
    if (!isProjectModule(file)) return undefined;
    const match = this.files.kindOf(file);
    if (match) {
      return match.kind === "infra"
        ? describeKind(this.show(file), match)
        : undefined;
    }
    if (!this.files.isPackageFile(file)) return undefined;
    const call = this.fromFile(file)?.resourceCall;
    return call
      ? `${this.show(file)}, an infra module (it calls ${call.name} at its top level)`
      : undefined;
  }

  /**
   * Fails if a module that `files.infra` or `files.shared` matches holds a
   * declaration. The runtime build can't bundle a function whose module is
   * infra, and neither build strips a shared module.
   */
  checkDeclaration(file: string, analysis: ModuleAnalysis) {
    const { declaration } = analysis;
    const match = this.kindOf(file);
    if (!declaration || !match || match.kind === "runtime") return;
    const name = this.show(file);
    const why =
      match.kind === "infra"
        ? "The runtime build leaves infra modules out, so it can't bundle the function."
        : "Neither build strips a shared module, so it can't hold a declaration.";
    throw new Error(
      `${name}:${location(analysis.table.module.source, declaration.call.start)}: ${describeKind(name, match)}, declares a function with ${declaration.name}. ${why} Move the declaration to a runtime module.`,
    );
  }

  /**
   * Fails if a module that `files.shared` matches holds a declaration,
   * imports a resource function, or imports an infra or runtime module. The
   * last is checked through the value imports of the modules that it
   * imports, up to an infra or runtime module or a package file.
   */
  checkShared(file: string) {
    const match = this.kindOf(file);
    if (match?.kind !== "shared") return;
    const analysis = this.fromFile(file);
    if (!analysis) return;
    this.checkDeclaration(file, analysis);
    const name = this.show(file);
    const at = (step: Step) =>
      `${this.show(step.file)}:${location(this.fromFile(step.file)!.table.module.source, step.start)}`;
    const shared = describeKind(name, match);

    const resource = resourceImport(analysis, this.marks);
    if (resource) {
      throw new Error(
        `${at({ file, start: resource.start })}: ${shared}, imports the resource function ${resource.name} from ${resource.source}. A shared module runs in the runtime build, where a resource function can't run. Move the code that uses ${resource.name} to an infra module.`,
      );
    }

    const found = this.#forbiddenImport(file, analysis);
    if (!found) return;
    const steps: Step[] = [];
    for (let step: Step | undefined = found.step; step; step = step.previous)
      steps.unshift(step);
    const chain = [...steps.map(at), this.show(found.target)].join(" → ");
    const advice =
      found.match.kind === "infra"
        ? "Read infra values in a function through its declaration's env(), and move code that both builds need to a shared module."
        : "Move the code that the shared module needs from the runtime module to a shared module.";
    throw new Error(
      `${at(steps[0]!)}: ${shared}, imports ${describeKind(this.show(found.target), found.match)}, through ${chain}. Neither build strips a shared module, so it can't import an infra or runtime module, directly or through other modules. ${advice}`,
    );
  }

  // The shortest chain of value imports from a shared module to an infra or
  // runtime module. The walk doesn't enter package files, which have no
  // kind.
  #forbiddenImport(
    file: string,
    analysis: ModuleAnalysis,
  ): { step: Step; target: string; match: KindMatch } | undefined {
    const seen = new Set([file]);
    const queue: { file: string; analysis: ModuleAnalysis; previous?: Step }[] =
      [{ file, analysis }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      for (const { source, start } of valueImports(current.analysis)) {
        const target = this.marks.resolve(source, current.file);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const step = { file: current.file, start, previous: current.previous };
        const match = this.kindOf(target);
        if (match?.kind === "infra" || match?.kind === "runtime") {
          return { step, target, match };
        }
        if (this.files.isPackageFile(target)) continue;
        const next = this.fromFile(target);
        if (next) queue.push({ file: target, analysis: next, previous: step });
      }
    }
    return undefined;
  }
}

// The imports and re-exports that load a module at runtime, with the
// position of each statement. An import counts if it has no specifiers, or
// if the module uses one of its names as a value. TypeScript removes an
// import whose names are used only in types.
function valueImports(
  analysis: ModuleAnalysis,
): { source: string; start: number }[] {
  const { table, references } = analysis;
  const used = new Set(references.map(({ node }) => node.name));
  for (const target of table.exports.values()) {
    if ("local" in target) used.add(target.local);
  }
  const found: { source: string; start: number }[] = [];
  for (const statement of table.module.body) {
    const { type } = statement;
    if (type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      const values = statement.specifiers.filter(
        (specifier: Node) => specifier.importKind !== "type",
      );
      if (
        statement.specifiers.length > 0 &&
        !values.some((specifier: Node) => used.has(specifier.local.name))
      )
        continue;
    } else if (type === "ExportNamedDeclaration") {
      if (!statement.source || statement.exportKind === "type") continue;
      if (
        statement.specifiers.length > 0 &&
        statement.specifiers.every(
          (specifier: Node) => specifier.exportKind === "type",
        )
      )
        continue;
    } else if (type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue;
    } else {
      continue;
    }
    found.push({ source: statement.source.value, start: statement.start });
  }
  return found;
}

type ResourceImport = { name: string; source: string; start: number };

// The first resource function that a module imports, as a value, or
// re-exports.
function resourceImport(
  analysis: ModuleAnalysis,
  marks: Marks,
): ResourceImport | undefined {
  const { table, references, marked } = analysis;
  const file = table.module.file;
  const used = new Set(references.map(({ node }) => node.name));
  for (const target of table.exports.values()) {
    if ("local" in target) used.add(target.local);
  }
  for (const [local, binding] of table.imports) {
    if (binding.imported === "*" || !used.has(local)) continue;
    if (marks.importMark(file, binding)?.kind === "resource") {
      return {
        name: binding.imported === "default" ? local : binding.imported,
        source: binding.source,
        start: binding.specifier.start,
      };
    }
  }
  // A namespace import counts through the members that the module uses,
  // such as `sqs.queue`.
  for (const reference of marked) {
    const binding = table.imports.get(reference.node.name);
    if (reference.mark.kind === "resource" && binding?.imported === "*") {
      return {
        name: reference.name,
        source: binding.source,
        start: reference.node.start,
      };
    }
  }
  for (const statement of table.module.body) {
    if (!statement.source || statement.exportKind === "type") continue;
    const resolved = marks.resolve(statement.source.value, file);
    if (!resolved) continue;
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.exportKind === "type") continue;
        const name =
          specifier.local.type === "Identifier"
            ? specifier.local.name
            : specifier.local.value;
        if (marks.exportMark(resolved, name)?.kind === "resource") {
          return {
            name,
            source: statement.source.value,
            start: specifier.start,
          };
        }
      }
    }
    if (statement.type === "ExportAllDeclaration") {
      const name = resourceExport(resolved, marks, new Set());
      if (name) {
        return { name, source: statement.source.value, start: statement.start };
      }
    }
  }
  return undefined;
}

// The name of a resource function that a module exports, directly or
// through `export * from`.
function resourceExport(
  file: string,
  marks: Marks,
  seen: Set<string>,
): string | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);
  const table = marks.table(file);
  if (!table) return undefined;
  for (const name of table.exports.keys()) {
    if (marks.exportMark(file, name)?.kind === "resource") return name;
  }
  for (const source of table.stars) {
    const resolved = marks.resolve(source, file);
    const name = resolved && resourceExport(resolved, marks, seen);
    if (name) return name;
  }
  return undefined;
}
