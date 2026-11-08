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
  glob: string;
  /** Whether the glob is a default, not set in the config. */
  isDefault: boolean;
};

const normalise = (glob: string) => glob.replace(/^(!?)\.\//, "$1");

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
  readonly globs: Required<ModuleGlobs>;
  #defaults: Set<ModuleKind>;
  #root?: string;
  #kinds = new Map<string, KindMatch | undefined>();
  #packageDirs = new Map<string, boolean>();

  /**
   * @param globs The globs that the config sets, by kind.
   * @param root The directory that the globs are relative to. Defaults to
   * the directory of the config.
   */
  constructor(globs: ModuleGlobs = {}, root?: string) {
    this.globs = { ...defaultModuleGlobs };
    this.#defaults = new Set();
    for (const kind of moduleKinds) {
      const set = globs[kind];
      if (set) this.globs[kind] = set.map(normalise);
      else this.#defaults.add(kind);
    }
    this.#root = root;
  }

  get root(): string {
    return (this.#root ??= projectRoot());
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
    const globs = this.globs[kind];
    const excluded = globs.some(
      (glob) =>
        glob.startsWith("!") && path.posix.matchesGlob(relative, glob.slice(1)),
    );
    if (excluded) return undefined;
    const glob = globs.find(
      (glob) => !glob.startsWith("!") && path.posix.matchesGlob(relative, glob),
    );
    if (!glob) return undefined;
    return { kind, glob, isDefault: this.#defaults.has(kind) };
  }

  /** The script files of a kind, as absolute paths, sorted. */
  list(kind: ModuleKind): string[] {
    return this.#scriptFiles(this.globs[kind]).filter(
      (file) => this.kindOf(file)?.kind === kind,
    );
  }

  /** Fails if two kinds match a script file. */
  checkOverlaps() {
    for (const file of this.#scriptFiles(
      moduleKinds.flatMap((kind) => this.globs[kind]),
    ))
      this.kindOf(file);
  }

  #scriptFiles(globs: string[]): string[] {
    const included = globs.filter((glob) => !glob.startsWith("!"));
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
    for (
      let dir = path.dirname(file);
      dir !== this.root && dir !== path.dirname(dir);
      dir = path.dirname(dir)
    ) {
      if (this.#isPackageDir(dir)) return true;
    }
    return false;
  }

  #isPackageDir(dir: string): boolean {
    let found = this.#packageDirs.get(dir);
    if (found === undefined) {
      const manifest = path.join(dir, "package.json");
      found = false;
      if (fs.existsSync(manifest)) {
        try {
          found =
            typeof JSON.parse(fs.readFileSync(manifest, "utf8")).name ===
            "string";
        } catch {
          found = false;
        }
      }
      this.#packageDirs.set(dir, found);
    }
    return found;
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
