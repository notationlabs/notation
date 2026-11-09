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

const globCharacters = /[*?[\]{}()!+@]/;

// Removes a leading `./`. A glob that ends in `/`, or that has no glob
// characters and names a folder, such as `infra`, matches the files in
// that folder.
function normalise(glob: string, root: string): string {
  const negated = glob.startsWith("!");
  let body = (negated ? glob.slice(1) : glob).replace(/^\.\//, "");
  if (body.endsWith("/")) body = `${body}**`;
  else if (!globCharacters.test(body) && isDirectory(path.join(root, body)))
    body = `${body}/**`;
  return negated ? `!${body}` : body;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
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
  #globs?: Required<ModuleGlobs>;
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

  /** The globs of each kind, with the defaults for the kinds that the config doesn't set. */
  get globs(): Required<ModuleGlobs> {
    if (this.#globs) return this.#globs;
    const globs = { ...defaultModuleGlobs };
    for (const kind of moduleKinds) {
      const set = this.#config[kind];
      if (set) globs[kind] = set.map((glob) => normalise(glob, this.root));
      else this.#defaults.add(kind);
    }
    return (this.#globs = globs);
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
