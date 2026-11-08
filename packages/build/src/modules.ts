import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "@notation/core";
import { analyzeModule, type ModuleAnalysis } from "./analyze";
import { location, type Node } from "./ast";
import { Marks } from "./marks";

export const nodeModules = /[\\/]node_modules[\\/]/;
export const scriptFile = /\.[cm]?[jt]sx?$/;

/**
 * The kind of a module.
 *
 * - `runtime`: the module has a declaration, such as `$lambda`.
 * - `infra`: a project module that imports a resource function, or imports
 *   an infra module. A package module outside `node_modules` is infra only
 *   if it calls a resource function at its top level.
 * - `shared`: any other module.
 */
export type ModuleKind =
  | { kind: "runtime"; declaration: string }
  | { kind: "infra"; reason: InfraReason }
  | { kind: "shared" };

/**
 * Why a module is infra: the resource function that it imports, the infra
 * module that it imports, or, for a package module, the resource function
 * that it calls at its top level. `source` is the specifier of the import,
 * and `start` is the position of the import or the call in the module.
 */
export type InfraReason =
  | { resource: string; source: string; start: number }
  | { module: string; source: string; start: number }
  | { call: string; start: number };

/** An import or re-export of a module, by its specifier. */
type ModuleImport = { source: string; statement: Node };

export type ModuleAnalysesOptions = {
  marks?: Marks;
  /**
   * Globs, relative to `root`, for the modules that are shared. A leading
   * `./` is allowed. Defaults to none.
   */
  sharedModules?: string[];
  /** The project root. Defaults to the directory of the config. */
  root?: string;
};

/**
 * Analyses and classifies project modules for both builds. An analysis is
 * kept until its file changes. A classification is kept until any analysis
 * changes, since it depends on the modules that the module imports.
 */
export class ModuleAnalyses {
  readonly marks: Marks;
  readonly sharedModules: string[];
  #root?: string;
  #analyses = new Map<string, ModuleAnalysis>();
  #kinds = new Map<string, ModuleKind | undefined>();
  // For each infra module in #kinds, the number of infra modules in its
  // chain after it.
  #depths = new Map<string, number>();
  // Directories, and whether the nearest package.json with a name above
  // each one belongs to a package.
  #packageDirs = new Map<string, boolean>();

  constructor(options: ModuleAnalysesOptions = {}) {
    this.marks = options.marks ?? new Marks();
    this.sharedModules = (options.sharedModules ?? []).map((glob) =>
      glob.replace(/^\.\//, ""),
    );
    this.#root = options.root;
  }

  get root(): string {
    return (this.#root ??= projectRoot());
  }

  /**
   * Whether a file is a project module, which `kind` classifies by its
   * imports. A file in `node_modules` is in a package. Any other file under
   * the project root is a project module, even in a folder with its own
   * package.json. A file outside the root is in a package when its nearest
   * package.json with a name is in a directory that doesn't contain the
   * root: a workspace package resolves to its real path, outside
   * `node_modules`.
   */
  isProjectModule(file: string): boolean {
    if (!isLocalModule(file)) return false;
    if (isInside(this.root, file)) return true;
    return !this.#inPackage(path.dirname(file));
  }

  #inPackage(dir: string): boolean {
    let inPackage = this.#packageDirs.get(dir);
    if (inPackage !== undefined) return inPackage;
    const manifest = path.join(dir, "package.json");
    const parent = path.dirname(dir);
    if (fs.existsSync(manifest) && hasName(manifest)) {
      inPackage = !isInside(dir, this.root);
    } else {
      inPackage = parent === dir ? false : this.#inPackage(parent);
    }
    this.#packageDirs.set(dir, inPackage);
    return inPackage;
  }

  /**
   * Analyses a module from the source that a transform hook sees. Each
   * runtime build transforms the same files, so an analysis of the same
   * source is reused. The kinds are cleared only if a kind could depend on
   * the module: it replaces an analysis, or a walk reached the module.
   */
  fromSource(file: string, source: string): ModuleAnalysis {
    const cached = this.#analyses.get(file);
    if (cached?.table.module.source === source) return cached;
    const analysis = analyzeModule(
      this.marks.setSource(file, source),
      this.marks,
    );
    this.#analyses.set(file, analysis);
    if (cached || this.#kinds.has(file)) this.#clearKinds();
    return analysis;
  }

  #clearKinds() {
    this.#kinds.clear();
    this.#depths.clear();
  }

  /**
   * Analyses a module from the file system: a project module, or a package
   * module outside `node_modules`, such as a file of a workspace package.
   */
  fromFile(file: string): ModuleAnalysis | undefined {
    if (!isLocalModule(file)) return undefined;
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
    this.#clearKinds();
    this.#packageDirs.clear();
  }

  isListedShared(file: string): boolean {
    if (this.sharedModules.length === 0 || !this.isProjectModule(file))
      return false;
    const relative = path.relative(this.root, file).split(path.sep).join("/");
    return this.sharedModules.some((glob) => path.matchesGlob(relative, glob));
  }

  /**
   * The kind of a module, or `undefined` for a file that the build doesn't
   * analyse, such as a file in `node_modules`. A package module outside
   * `node_modules` is runtime if it has a declaration, infra if it calls a
   * resource function at its top level, and shared otherwise. The rules
   * below apply to project modules.
   *
   * 1. A module with a declaration is runtime.
   * 2. A module that `sharedModules` matches is shared.
   * 3. A module that imports a resource function is infra.
   * 4. A module that imports an infra module is infra. This repeats until
   *    no module changes, over the modules that the first module reaches.
   *    Imports of packages aren't followed, and runtime and listed shared
   *    modules stop the walk, since their kind doesn't depend on their
   *    imports.
   * 5. Any other module is shared.
   */
  kind(file: string): ModuleKind | undefined {
    if (this.#kinds.has(file)) return this.#kinds.get(file);
    if (!this.isProjectModule(file)) {
      const kind = packageKind(this.#tryFromFile(file));
      this.#kinds.set(file, kind);
      return kind;
    }
    const found = new Map<string, ModuleKind | undefined>();
    const pending = new Map<string, { file: string; import: ModuleImport }[]>();
    const queue = [file];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!;
      if (found.has(next) || pending.has(next)) continue;
      if (this.#kinds.has(next)) {
        found.set(next, this.#kinds.get(next));
        continue;
      }
      const analysis = this.#tryFromFile(next);
      if (!analysis) {
        found.set(next, undefined);
        continue;
      }
      const base = baseKind(analysis, this.isListedShared(next));
      if (base) {
        found.set(next, base);
        continue;
      }
      const edges = this.#imports(analysis).flatMap((imported) => {
        const target = this.marks.resolve(imported.source, next);
        return target && this.isProjectModule(target)
          ? [{ file: target, import: imported }]
          : [];
      });
      pending.set(next, edges);
      queue.push(...edges.map((edge) => edge.file));
    }

    // A breadth-first walk from the infra modules to the modules that import
    // them, in order of depth. Each module takes its first import of an
    // infra module with the smallest depth, so each reason points to a
    // shortest chain.
    const importers = new Map<string, string[]>();
    for (const [module, edges] of pending) {
      for (const edge of edges) {
        const list = importers.get(edge.file) ?? [];
        list.push(module);
        importers.set(edge.file, list);
      }
    }
    const depths = new Map<string, number>();
    const byDepth: string[][] = [];
    for (const [module, kind] of found) {
      if (kind?.kind !== "infra") continue;
      const depth = this.#depths.get(module) ?? 0;
      depths.set(module, depth);
      (byDepth[depth] ??= []).push(module);
    }
    for (let depth = 0; depth < byDepth.length; depth++) {
      for (const infra of byDepth[depth] ?? []) {
        for (const module of importers.get(infra) ?? []) {
          if (depths.has(module)) continue;
          const edge = pending
            .get(module)!
            .find((edge) => depths.get(edge.file) === depth)!;
          depths.set(module, depth + 1);
          (byDepth[depth + 1] ??= []).push(module);
          found.set(module, {
            kind: "infra",
            reason: {
              module: edge.file,
              source: edge.import.source,
              start: edge.import.statement.start,
            },
          });
        }
      }
    }
    for (const module of pending.keys()) {
      if (!depths.has(module)) found.set(module, { kind: "shared" });
    }
    for (const [module, kind] of found) this.#kinds.set(module, kind);
    for (const [module, depth] of depths) this.#depths.set(module, depth);
    return found.get(file);
  }

  // A module that can't be analysed has no kind here. The bundler reports
  // its error when it loads the module.
  #tryFromFile(file: string): ModuleAnalysis | undefined {
    try {
      return this.fromFile(file);
    } catch {
      return undefined;
    }
  }

  /**
   * The value imports and re-exports of a module, including side-effect
   * imports. An import is left out if its specifiers are all `type`, or if
   * the module uses its bindings only in types, since TypeScript removes
   * such an import.
   */
  #imports(analysis: ModuleAnalysis): ModuleImport[] {
    const imports: ModuleImport[] = [];
    for (const statement of analysis.table.module.body) {
      if (!statement.source) continue;
      const isValue =
        statement.type === "ImportDeclaration"
          ? statement.importKind !== "type" &&
            (statement.specifiers.length === 0 ||
              statement.specifiers.some(
                (s: Node) =>
                  s.importKind !== "type" &&
                  analysis.valueNames.has(s.local.name),
              ))
          : statement.type === "ExportNamedDeclaration"
            ? statement.exportKind !== "type" &&
              (statement.specifiers.length === 0 ||
                statement.specifiers.some((s: Node) => s.exportKind !== "type"))
            : statement.type === "ExportAllDeclaration" &&
              statement.exportKind !== "type";
      if (isValue) imports.push({ source: statement.source.value, statement });
    }
    return imports;
  }

  /**
   * Says why a module is an infra or runtime module, such as `an infra
   * module because it imports infra/orders.ts (lib/format.ts:1:1), which
   * imports queue from @notation/aws/sqs (infra/orders.ts:1:10)`. Each step
   * gives the position of the import. Returns `undefined` for a shared
   * module.
   */
  describeKind(file: string): string | undefined {
    const kind = this.kind(file);
    if (!kind || kind.kind === "shared") return undefined;
    if (kind.kind === "runtime") {
      return `a runtime module because it declares a function with ${kind.declaration}`;
    }
    const at = (module: string, start: number) => {
      const source = this.#analyses.get(module)?.table.module.source;
      const name = displayPath(module, this.root);
      return source === undefined ? name : `${name}:${location(source, start)}`;
    };
    const steps: string[] = [];
    let module = file;
    let reason = kind.reason;
    while ("module" in reason) {
      steps.push(
        `imports ${displayPath(reason.module, this.root)} (${at(module, reason.start)})`,
      );
      const next = this.kind(reason.module);
      if (next?.kind !== "infra")
        return `an infra module because it ${steps.join(", which ")}`;
      module = reason.module;
      reason = next.reason;
    }
    steps.push(
      "call" in reason
        ? `calls ${reason.call} at its top level (${at(module, reason.start)})`
        : `imports ${reason.resource} from ${reason.source} (${at(module, reason.start)})`,
    );
    return `an infra module because it ${steps.join(", which ")}`;
  }

  /**
   * Fails if a project module that isn't infra imports a module only for its
   * side effects, as in `import "./setup"`, and the imported module is infra
   * only through its imports. The runtime build leaves infra modules out, so
   * the imported module's own top-level code wouldn't run in the function.
   * A module that imports a resource function itself is left out silently:
   * its top-level code declares resources, which must not run in the
   * function.
   */
  checkEffectImports(file: string) {
    if (!this.isProjectModule(file) || this.kind(file)?.kind === "infra")
      return;
    const analysis = this.fromFile(file);
    if (!analysis) return;
    const { source, body } = analysis.table.module;
    const name = displayPath(file, this.root);
    for (const statement of body) {
      if (!isEffectImport(statement)) continue;
      const target = this.marks.resolve(statement.source.value, file);
      if (!target) continue;
      const kind = this.kind(target);
      if (kind?.kind !== "infra" || !("module" in kind.reason)) continue;
      const imported = displayPath(target, this.root);
      throw new Error(
        `${name}:${location(source, statement.start)}: ${name} imports ${imported} for its side effects, but ${imported} is ${this.describeKind(target)}. The runtime build leaves infra modules out, so the top-level code of ${imported} doesn't run in the function. Move the code that the function needs to run to a module that doesn't import infra, and import that module instead.`,
      );
    }
  }

  /**
   * Fails if a module that `sharedModules` matches can't be shared: it has a
   * declaration, imports a resource function, or imports an infra or runtime
   * module. The error names the line of the import.
   */
  checkShared(file: string) {
    if (!this.isListedShared(file)) return;
    const analysis = this.fromFile(file);
    if (!analysis) return;
    const { source } = analysis.table.module;
    const name = displayPath(file, this.root);
    const fail = (start: number, message: string): never => {
      throw new Error(
        `${name}:${location(source, start)}: ${name} matches sharedModules, but ${message}. A shared module runs in both builds, so it can't declare a function or resources, or import an infra or runtime module.`,
      );
    };
    if (analysis.declaration) {
      fail(
        analysis.declaration.call.start,
        `it declares a function with ${analysis.declaration.name}`,
      );
    }
    if (analysis.resource) {
      fail(
        analysis.resource.start,
        `it imports the resource function ${analysis.resource.name} from ${analysis.resource.source}`,
      );
    }
    for (const imported of this.#imports(analysis)) {
      const target = this.marks.resolve(imported.source, file);
      if (!target) continue;
      const why = this.describeKind(target);
      if (!why) continue;
      fail(
        imported.statement.start,
        `it imports ${displayPath(target, this.root)}, which is ${why}`,
      );
    }
  }
}

function baseKind(
  analysis: ModuleAnalysis,
  listed: boolean,
): ModuleKind | undefined {
  if (analysis.declaration) {
    return { kind: "runtime", declaration: analysis.declaration.name };
  }
  if (listed) return { kind: "shared" };
  if (analysis.resource) {
    const { name, source, start } = analysis.resource;
    return { kind: "infra", reason: { resource: name, source, start } };
  }
  return undefined;
}

function packageKind(
  analysis: ModuleAnalysis | undefined,
): ModuleKind | undefined {
  if (!analysis) return undefined;
  if (analysis.declaration) {
    return { kind: "runtime", declaration: analysis.declaration.name };
  }
  const call = analysis.resourceCall;
  if (call) {
    return {
      kind: "infra",
      reason: { call: call.name, start: call.call!.start },
    };
  }
  return { kind: "shared" };
}

// The files that the builds analyse: JS and TS files outside `node_modules`.
export function isLocalModule(file: string): boolean {
  return (
    !file.startsWith("\0") && scriptFile.test(file) && !nodeModules.test(file)
  );
}

// An import or re-export with no bindings, such as `import "./setup"` or
// `export {} from "./setup"`, which loads a module only for its side effects.
function isEffectImport(statement: Node): boolean {
  if (!statement.source || statement.specifiers?.length !== 0) return false;
  return statement.type === "ImportDeclaration"
    ? statement.importKind !== "type"
    : statement.type === "ExportNamedDeclaration" &&
        statement.exportKind !== "type";
}

// Whether `file` is `dir` or is under it.
function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function hasName(manifest: string): boolean {
  try {
    return (
      typeof JSON.parse(fs.readFileSync(manifest, "utf8")).name === "string"
    );
  } catch {
    return false;
  }
}

/**
 * A file for an error message, relative to the project root. A package file
 * is named by its package, such as `@notation/aws/dist/sqs/index.js`. A
 * workspace package resolves to its real path, so a path relative to the
 * project root would read as `../../aws/dist/sqs/index.js`. A file counts as
 * a package file by the rule of `isProjectModule`, so a project module
 * outside the root keeps its relative path, such as `../common/fmt.ts`.
 */
export function displayPath(file: string, root: string = projectRoot()) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!nodeModules.test(file) && !relative.startsWith("..")) return relative;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && hasName(manifest)) {
      if (!nodeModules.test(file) && isInside(dir, root)) return relative;
      const { name } = JSON.parse(fs.readFileSync(manifest, "utf8"));
      return [name, ...path.relative(dir, file).split(path.sep)].join("/");
    }
    if (dir === path.dirname(dir)) return relative;
  }
}
