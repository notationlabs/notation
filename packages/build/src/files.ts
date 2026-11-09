import fs from "node:fs";
import path from "node:path";
import {
  defaultModuleGlobs,
  moduleKinds,
  projectRoot,
  type ModuleGlobs,
  type ModuleKind,
} from "@notation/core";

export const nodeModules = /[\\/]node_modules[\\/]/;
export const scriptFile = /\.[cm]?[jt]sx?$/;

// The directories that no kind of module is in, at any depth: build output,
// packages, and dot-directories such as .notation/, where deploy writes its
// state.
const ignoredNames = ["dist", "node_modules"];
export const isIgnoredDirectory = (name: string) =>
  ignoredNames.includes(name) || name.startsWith(".");

/** Globs that match the directories that no kind of module is in. */
export const ignoredGlobs = [
  ...ignoredNames.map((name) => `**/${name}/**`),
  "**/.*/**",
];

/** The kind of a file, and the glob of `files` that gives it that kind. */
export type KindMatch = {
  kind: ModuleKind;
  /** The glob as the config writes it. */
  glob: string;
  /** Whether the glob is a default, not set in the config. */
  isDefault: boolean;
};

/** The characters that make a path a glob. */
export const globCharacters = /[*?[{]/;

// A glob of the config, and the patterns that it matches with.
type Glob = { written: string; negated: boolean; patterns: string[] };

// Removes a leading `!` and `./`. A glob that ends in `/` matches the files
// in that folder. A glob with no glob characters, such as `infra`, matches
// the file of that path and the files in a folder of that path. Neither
// reads the file system, so a folder created in watch mode is matched.
function parseGlob(written: string): Glob {
  const negated = written.startsWith("!");
  const body = (negated ? written.slice(1) : written).replace(/^\.\//, "");
  let patterns = [body];
  if (body.endsWith("/")) patterns = [`${body}**`];
  else if (!globCharacters.test(body)) patterns = [body, `${body}/**`];
  return { written, negated, patterns };
}

// The real path of the root, because the bundler gives real paths. A root
// that doesn't exist is kept as it is.
function realRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

const articles: Record<ModuleKind, string> = {
  infra: "an infra",
  runtime: "a runtime",
  shared: "a shared",
};

/**
 * Gives each project file its kind of module, from the globs of `files` in
 * the config. A kind that the config doesn't set uses its default globs. A
 * file has a kind if it is under the project root, outside the directories
 * that `isIgnoredDirectory` names, and matches a glob of the kind but none
 * of its globs that start with `!`. A file that two kinds match is an
 * error.
 */
export class FileKinds {
  #config: ModuleGlobs;
  #parsed?: Record<ModuleKind, Glob[]>;
  #defaults = new Set<ModuleKind>();
  #root?: string;
  #realRoot?: string;
  #kinds = new Map<string, KindMatch | undefined>();
  #packageNames = new Map<string, string | undefined>();

  /**
   * @param globs The globs that the config sets, by kind.
   * @param root The directory that the globs are relative to. Defaults to
   * the directory of the config.
   */
  constructor(globs: ModuleGlobs = {}, root?: string) {
    this.#config = globs;
    this.#root = root;
  }

  get root(): string {
    return (this.#realRoot ??= realRoot(this.#root ?? projectRoot()));
  }

  #globsOf(kind: ModuleKind): Glob[] {
    if (!this.#parsed) {
      const parsed = {} as Record<ModuleKind, Glob[]>;
      for (const kind of moduleKinds) {
        const set = this.#config[kind];
        if (!set) this.#defaults.add(kind);
        parsed[kind] = (set ?? defaultModuleGlobs[kind]).map(parseGlob);
      }
      this.#parsed = parsed;
    }
    return this.#parsed[kind];
  }

  /**
   * The patterns that select the files of a kind, without `!` globs, with
   * the defaults for a kind that the config doesn't set.
   */
  includedPatterns(kind: ModuleKind): string[] {
    return this.#globsOf(kind).flatMap((glob) =>
      glob.negated ? [] : glob.patterns,
    );
  }

  /** The kind of a file, by its absolute path. */
  kindOf(file: string): KindMatch | undefined {
    if (this.#kinds.has(file)) return this.#kinds.get(file);
    const relative = this.#relative(file);
    let found: KindMatch | undefined;
    if (relative !== undefined) {
      for (const kind of moduleKinds) {
        const match = this.#match(kind, relative);
        if (!match) continue;
        if (found) throw new Error(overlap(relative, found, match));
        found = match;
      }
    }
    this.#kinds.set(file, found);
    return found;
  }

  #relative(file: string): string | undefined {
    const relative = path.relative(this.root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    const segments = relative.split(path.sep);
    if (segments.slice(0, -1).some(isIgnoredDirectory)) return;
    return segments.join("/");
  }

  #match(kind: ModuleKind, relative: string): KindMatch | undefined {
    const globs = this.#globsOf(kind);
    const matches = (glob: Glob) =>
      glob.patterns.some((pattern) =>
        path.posix.matchesGlob(relative, pattern),
      );
    if (globs.some((glob) => glob.negated && matches(glob))) return undefined;
    const glob = globs.find((glob) => !glob.negated && matches(glob));
    if (!glob) return undefined;
    return { kind, glob: glob.written, isDefault: this.#defaults.has(kind) };
  }

  /** The script files of a kind, as absolute paths, sorted. */
  list(kind: ModuleKind): string[] {
    return this.#scriptFiles(this.includedPatterns(kind)).filter(
      (file) => this.kindOf(file)?.kind === kind,
    );
  }

  /** Fails if two kinds match a script file. */
  checkOverlaps() {
    for (const file of this.#scriptFiles(
      moduleKinds.flatMap((kind) => this.includedPatterns(kind)),
    ))
      this.kindOf(file);
  }

  #scriptFiles(included: string[]): string[] {
    if (included.length === 0) return [];
    return fs
      .globSync(included, {
        cwd: this.root,
        exclude: (file) => isIgnoredDirectory(path.basename(file)),
      })
      .filter((file) => scriptFile.test(file))
      .map((file) => path.resolve(this.root, file))
      .sort();
  }

  /**
   * Whether a file is in a package: in `node_modules`, outside the project
   * root, or under a directory below the root with a `package.json` that has
   * a name. A workspace package resolves to its real path, outside
   * `node_modules`. Such a file has no kind, and the build infers whether it
   * is infra from its own code.
   */
  isPackageFile(file: string): boolean {
    if (nodeModules.test(file)) return true;
    const relative = path.relative(this.root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
    const root = this.root;
    for (
      let dir = path.dirname(file);
      dir !== root && dir !== path.dirname(dir);
      dir = path.dirname(dir)
    ) {
      if (this.packageName(dir) !== undefined) return true;
    }
    return false;
  }

  /** The `name` in the `package.json` of a folder, if it has one. */
  packageName(dir: string): string | undefined {
    if (this.#packageNames.has(dir)) return this.#packageNames.get(dir);
    let name: string | undefined;
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")).name;
        if (typeof parsed === "string") name = parsed;
      } catch {}
    }
    this.#packageNames.set(dir, name);
    return name;
  }

  /**
   * A file for an error message. A package file is named by its package,
   * such as `@notation/aws/dist/sqs/index.js`. A workspace package resolves
   * to its real path, so a path relative to the project root would read as
   * `../../aws/dist/sqs/index.js`.
   */
  show(file: string): string {
    const relative = path.relative(this.root, file).split(path.sep).join("/");
    if (!nodeModules.test(file) && !relative.startsWith("..")) return relative;
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const name = this.packageName(dir);
      if (name !== undefined) {
        return [name, ...path.relative(dir, file).split(path.sep)].join("/");
      }
      if (dir === path.dirname(dir)) return relative;
    }
  }
}

/** A glob of `files`, for an error message, such as `files.infra: "infra/**"`. */
export function describeGlob(match: KindMatch): string {
  return `files.${match.kind}: ${JSON.stringify(match.glob)}${match.isDefault ? ", the default" : ""}`;
}

/**
 * A file and its kind, for an error message, such as
 * `infra/orders.ts, an infra module (files.infra: "infra/**", the default)`.
 */
export function describeKind(name: string, match: KindMatch): string {
  return `${name}, ${articles[match.kind]} module (${describeGlob(match)})`;
}

function overlap(relative: string, a: KindMatch, b: KindMatch): string {
  const message = `${relative} matches both files.${a.kind} and files.${b.kind} (${describeGlob(a)}; ${describeGlob(b)}). A file can have only one kind. Change the globs so that only one of them matches it.`;
  const byDefault = [a, b].find((match) => match.isDefault);
  if (!byDefault) return message;
  return `${message} files.${byDefault.kind} isn't set in the config, so it has its default globs. Set it to replace them, or set it to [] for no ${byDefault.kind} modules.`;
}
