import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "@notation/core";
import { analyzeModule, type ModuleAnalysis } from "./analyze";
import { location, type Node } from "./ast";
import { Marks } from "./marks";

export const nodeModules = /[\\/]node_modules[\\/]/;
export const scriptFile = /\.[cm]?[jt]sx?$/;

/**
 * The kind of a project module.
 *
 * - `runtime`: the module has a declaration, such as `$lambda`.
 * - `infra`: the module imports a resource function, or imports an infra
 *   module.
 * - `shared`: any other module. `listed` is true when `sharedModules`
 *   matches the module.
 */
export type ModuleKind =
  | { kind: "runtime"; declaration: string }
  | { kind: "infra"; reason: InfraReason }
  | { kind: "shared"; listed: boolean };

/**
 * Why a module is infra: the resource function that it imports, or the
 * infra module that it imports. `start` is the position of the import.
 */
export type InfraReason =
  | { resource: string; source: string; start: number }
  | { module: string; source: string; start: number };

/** An import or re-export of a module, by its specifier. */
type ModuleImport = { source: string; statement: Node };

export type ModuleAnalysesOptions = {
  marks?: Marks;
  /**
   * Globs, relative to `root`, for the modules that are shared. Defaults to
   * none.
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
  // Directories, and whether the nearest package.json with a name above
  // each one belongs to a package.
  #packageDirs = new Map<string, boolean>();

  constructor(options: ModuleAnalysesOptions = {}) {
    this.marks = options.marks ?? new Marks();
    this.sharedModules = options.sharedModules ?? [];
    this.#root = options.root;
  }

  get root(): string {
    return (this.#root ??= projectRoot());
  }

  /**
   * Whether a file is a project module, which the builds analyse. A file in
   * `node_modules` is in a package. So is a file whose nearest package.json
   * with a name is in a directory that doesn't contain the project root:
   * a workspace package resolves to its real path, outside `node_modules`.
   */
  isProjectModule(file: string): boolean {
    if (file.startsWith("\0") || !scriptFile.test(file)) return false;
    if (nodeModules.test(file)) return false;
    return !this.#inPackage(path.dirname(file));
  }

  #inPackage(dir: string): boolean {
    let inPackage = this.#packageDirs.get(dir);
    if (inPackage !== undefined) return inPackage;
    const manifest = path.join(dir, "package.json");
    const parent = path.dirname(dir);
    if (fs.existsSync(manifest) && hasName(manifest)) {
      const relative = path.relative(dir, this.root);
      inPackage = relative.startsWith("..") || path.isAbsolute(relative);
    } else {
      inPackage = parent === dir ? false : this.#inPackage(parent);
    }
    this.#packageDirs.set(dir, inPackage);
    return inPackage;
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
    this.#kinds.clear();
    return analysis;
  }

  /** Analyses a module from the file system. */
  fromFile(file: string): ModuleAnalysis | undefined {
    if (!this.isProjectModule(file)) return undefined;
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
    this.#kinds.clear();
    this.#packageDirs.clear();
  }

  /** Whether `sharedModules` matches a file. */
  isListedShared(file: string): boolean {
    if (this.sharedModules.length === 0) return false;
    const relative = path.relative(this.root, file).split(path.sep).join("/");
    return this.sharedModules.some((glob) => path.matchesGlob(relative, glob));
  }

  /**
   * The kind of a module, or `undefined` for a file that isn't a project
   * module.
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
    const found = new Map<string, ModuleKind | undefined>();
    const pending = new Map<string, { file: string; import: ModuleImport }[]>();
    const queue = [file];
    while (queue.length > 0) {
      const next = queue.shift()!;
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
      const edges = this.imports(analysis).flatMap((imported) => {
        const target = this.marks.resolve(imported.source, next);
        return target && this.isProjectModule(target)
          ? [{ file: target, import: imported }]
          : [];
      });
      pending.set(next, edges);
      queue.push(...edges.map((edge) => edge.file));
    }

    // Each round adds the modules that import a module found to be infra in
    // an earlier round, so each reason points to a shortest chain.
    for (let changed = true; changed;) {
      changed = false;
      const infra: [string, ModuleKind][] = [];
      for (const [module, edges] of pending) {
        const edge = edges.find(
          (edge) => found.get(edge.file)?.kind === "infra",
        );
        if (!edge) continue;
        infra.push([
          module,
          {
            kind: "infra",
            reason: {
              module: edge.file,
              source: edge.import.source,
              start: edge.import.statement.start,
            },
          },
        ]);
      }
      for (const [module, kind] of infra) {
        found.set(module, kind);
        pending.delete(module);
        changed = true;
      }
    }
    for (const module of pending.keys()) {
      found.set(module, { kind: "shared", listed: false });
    }
    for (const [module, kind] of found) this.#kinds.set(module, kind);
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
   * imports. An import whose specifiers are all `type` is left out.
   */
  imports(analysis: ModuleAnalysis): ModuleImport[] {
    const imports: ModuleImport[] = [];
    for (const statement of analysis.table.module.body) {
      if (!statement.source) continue;
      const isValue =
        statement.type === "ImportDeclaration"
          ? statement.importKind !== "type" &&
            (statement.specifiers.length === 0 ||
              statement.specifiers.some((s: Node) => s.importKind !== "type"))
          : statement.type === "ExportNamedDeclaration"
            ? statement.exportKind !== "type" &&
              statement.specifiers.some((s: Node) => s.exportKind !== "type")
            : statement.type === "ExportAllDeclaration" &&
              statement.exportKind !== "type";
      if (isValue) imports.push({ source: statement.source.value, statement });
    }
    return imports;
  }

  /**
   * Says why a module is an infra or runtime module, such as `an infra
   * module because it imports infra/orders.ts, which imports queue from
   * @notation/aws/sqs`. Returns `undefined` for a shared module.
   */
  describeKind(file: string): string | undefined {
    const kind = this.kind(file);
    if (!kind || kind.kind === "shared") return undefined;
    if (kind.kind === "runtime") {
      return `a runtime module because it declares a function with ${kind.declaration}`;
    }
    const chain: string[] = [];
    let reason = kind.reason;
    while ("module" in reason) {
      chain.push(displayPath(reason.module, this.root));
      const next = this.kind(reason.module);
      if (next?.kind !== "infra") break;
      reason = next.reason;
    }
    const steps = chain.map((module) => `imports ${module}`);
    if ("resource" in reason) {
      steps.push(`imports ${reason.resource} from ${reason.source}`);
    }
    return `an infra module because it ${steps.join(", which ")}`;
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
    for (const imported of this.imports(analysis)) {
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
  if (listed) return { kind: "shared", listed: true };
  if (analysis.resource) {
    const { name, source, start } = analysis.resource;
    return { kind: "infra", reason: { resource: name, source, start } };
  }
  return undefined;
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
 * project root would read as `../../aws/dist/sqs/index.js`.
 */
export function displayPath(file: string, root: string = projectRoot()) {
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
