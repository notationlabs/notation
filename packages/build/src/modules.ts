import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "@notation/core";
import { analyzeModule, type ModuleAnalysis } from "./analyze";
import { location, type Node } from "./ast";
import { Marks } from "./marks";

export const nodeModules = /[\\/]node_modules[\\/]/;
export const scriptFile = /\.[cm]?[jt]sx?$/;

/**
 * The kind of a module, by its own code. The modules that it imports don't
 * change its kind.
 *
 * - `runtime`: the module has a declaration, such as `$lambda`.
 * - `infra`: the module calls a resource function at its top level.
 * - `shared`: any other module.
 */
export type ModuleKind =
  | { kind: "runtime"; declaration: string }
  | { kind: "infra"; call: string; start: number }
  | { kind: "shared" };

/** An import or re-export of a module, by its specifier. */
type ModuleImport = { source: string; statement: Node };

// A reason that a module can't be shared, at a position in the module.
type Problem = { message: string; start: number };

// A module that the walk of `checkShared` reaches, the position of the
// import that reached it, and the module that has that import.
type Step = { file: string; start: number; previous?: Step };

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
 * Analyses and classifies modules for both builds. An analysis is kept until
 * its file changes.
 */
export class ModuleAnalyses {
  readonly marks: Marks;
  readonly sharedModules: string[];
  #root?: string;
  #analyses = new Map<string, ModuleAnalysis>();
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
   * Whether a file is a project module, which `sharedModules` can match and
   * whose imports `checkShared` follows. A file in `node_modules` is in a
   * package. Any other file under the project root is a project module, even
   * in a folder with its own package.json. A file outside the root is in a
   * package when its nearest package.json with a name is in a directory that
   * doesn't contain the root: a workspace package resolves to its real path,
   * outside `node_modules`.
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
   * analyse, such as a file in `node_modules`. A module with a declaration is
   * runtime, even if it also calls a resource function.
   */
  kind(file: string): ModuleKind | undefined {
    const analysis = this.#tryFromFile(file);
    if (!analysis) return undefined;
    const { declaration, resourceCall } = analysis;
    if (declaration) return { kind: "runtime", declaration: declaration.name };
    if (resourceCall) {
      return {
        kind: "infra",
        call: exportedName(analysis, resourceCall),
        start: resourceCall.call!.start,
      };
    }
    return { kind: "shared" };
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

  // The local modules that the value imports of a module load, each with the
  // position of its import.
  #edges(file: string, analysis: ModuleAnalysis): Step[] {
    return this.#imports(analysis).flatMap(({ source, statement }) => {
      const target = this.marks.resolve(source, file);
      return target && isLocalModule(target)
        ? [{ file: target, start: statement.start }]
        : [];
    });
  }

  // A position in a module for an error message, such as `infra/orders.ts:3:23`.
  #at(file: string, start: number): string {
    const source = this.#analyses.get(file)?.table.module.source;
    const name = displayPath(file, this.root);
    return source === undefined ? name : `${name}:${location(source, start)}`;
  }

  /**
   * Says why a module is an infra or runtime module, such as `an infra
   * module because it calls queue at its top level (infra/orders.ts:3:23)`.
   * Returns `undefined` for a shared module.
   */
  describeKind(file: string): string | undefined {
    const kind = this.kind(file);
    if (!kind || kind.kind === "shared") return undefined;
    if (kind.kind === "runtime") {
      return `a runtime module because it declares a function with ${kind.declaration}`;
    }
    return `an infra module because it calls ${kind.call} at its top level (${this.#at(file, kind.start)})`;
  }

  // Why a module can't be shared, by its own code. A file outside the
  // project counts only if it declares a function or calls a resource
  // function at its top level, which are the same tests as for its kind.
  #problem(file: string, analysis: ModuleAnalysis): Problem | undefined {
    const { declaration, resource, resourceCall } = analysis;
    if (declaration) {
      return {
        message: `declares a function with ${declaration.name}`,
        start: declaration.call.start,
      };
    }
    if (resource && this.isProjectModule(file)) {
      return {
        message: `imports the resource function ${resource.name} from ${resource.source}`,
        start: resource.start,
      };
    }
    if (resourceCall) {
      return {
        message: `calls ${exportedName(analysis, resourceCall)} at its top level`,
        start: resourceCall.call!.start,
      };
    }
    return undefined;
  }

  // A breadth-first walk from `first` to the closest module that can't be
  // shared. It follows the imports of project modules only. `seen` holds the
  // modules that an earlier walk found no problem in.
  #findProblem(
    first: Step,
    seen: Set<string>,
  ): { step: Step; problem: Problem } | undefined {
    const queue = [first];
    for (let i = 0; i < queue.length; i++) {
      const step = queue[i]!;
      if (seen.has(step.file)) continue;
      seen.add(step.file);
      const analysis = this.#tryFromFile(step.file);
      if (!analysis) continue;
      const problem = this.#problem(step.file, analysis);
      if (problem) return { step, problem };
      if (!this.isProjectModule(step.file)) continue;
      for (const edge of this.#edges(step.file, analysis)) {
        queue.push({ ...edge, previous: step });
      }
    }
    return undefined;
  }

  /**
   * Fails if a module that `sharedModules` matches can't be shared: it
   * declares a function or imports a resource function, or a module that it
   * imports, directly or through other project modules, does. A file outside
   * the project ends the walk, and fails the check only if it declares a
   * function or calls a resource function at its top level. The error names
   * the first problem in the listed module, and the shortest chain of
   * imports to a module with a problem.
   */
  checkShared(file: string) {
    if (!this.isListedShared(file)) return;
    const analysis = this.fromFile(file);
    if (!analysis) return;
    const own = this.#problem(file, analysis);
    let found: { step: Step; problem: Problem } | undefined;
    if (!analysis.declaration) {
      const seen = new Set([file]);
      for (const edge of this.#edges(file, analysis)) {
        if (own && own.start < edge.start) break;
        found = this.#findProblem(edge, seen);
        if (found) break;
      }
    }
    let start: number;
    let message: string;
    if (found) {
      const steps: Step[] = [];
      for (let step: Step | undefined = found.step; step; step = step.previous)
        steps.unshift(step);
      const parts = steps.map((step, i) =>
        i === 0
          ? `imports ${displayPath(step.file, this.root)}`
          : `imports ${displayPath(step.file, this.root)} (${this.#at(steps[i - 1]!.file, step.start)})`,
      );
      parts.push(
        `${found.problem.message} (${this.#at(found.step.file, found.problem.start)})`,
      );
      start = steps[0]!.start;
      message = parts.join(", which ");
    } else if (own) {
      start = own.start;
      message = own.message;
    } else {
      return;
    }
    const name = displayPath(file, this.root);
    const { source } = analysis.table.module;
    throw new Error(
      `${name}:${location(source, start)}: ${name} matches sharedModules, but it ${message}. A shared module runs in both builds, so it can't declare a function or import a resource function, directly or through the modules that it imports.`,
    );
  }
}

// The name of a called resource function as its module exports it, such as
// `queue` for `import { queue as q }`.
function exportedName(
  analysis: ModuleAnalysis,
  reference: NonNullable<ModuleAnalysis["resourceCall"]>,
): string {
  const binding = analysis.table.imports.get(reference.node.name);
  return binding && binding.imported !== "*" && binding.imported !== "default"
    ? binding.imported
    : reference.name;
}

// The files that the builds analyse: JS and TS files outside `node_modules`.
export function isLocalModule(file: string): boolean {
  return (
    !file.startsWith("\0") && scriptFile.test(file) && !nodeModules.test(file)
  );
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
