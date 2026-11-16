import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "rolldown";
import { filePaths, projectRoot } from "@notation/core";
import { realRoot } from "../files";
import { functionBuildOptions } from "../options";
import manifest from "../../package.json" with { type: "json" };
import {
  buildBundle,
  projectGlobs,
  type BuiltBundle,
  type BundleSource,
} from "./compile";
import { sameFiles, sha256Base64, sha256Hex } from "./inputs";

/** The directory of a bundle's files: `dist/.bundles/<id>`. */
export const bundleDir = (id: string) =>
  path.join(filePaths.dist.dir(), ".bundles", id);

/** The inputs file of a bundle: `dist/.bundles/<id>/inputs.json`. */
const inputsFile = (id: string) => path.join(bundleDir(id), "inputs.json");

/** What a bundle records after each build. See `readInputs`. */
export type BundleInputs = {
  /** A hash of the bundle's options, sources and versions. */
  key: string;
  /**
   * A hash of each file that the build read, or that decides how its imports
   * resolve, by its path relative to the project root.
   */
  files: Record<string, string>;
  /** The base64 SHA-256 of the file that the bundle writes. */
  fileSha256: string;
};

// Writes a bundle's inputs file. A plan and a deploy can write the same file
// at once, so it is written to a temporary file and renamed.
function writeInputs(id: string, inputs: BundleInputs) {
  const file = inputsFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(inputs, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/** Reads a bundle's inputs file. Undefined when it is missing or invalid. */
export function readInputs(id: string): BundleInputs | undefined {
  try {
    const inputs = JSON.parse(fs.readFileSync(inputsFile(id), "utf8"));
    if (
      typeof inputs?.key !== "string" ||
      typeof inputs.files !== "object" ||
      inputs.files === null ||
      typeof inputs.fileSha256 !== "string"
    ) {
      return undefined;
    }
    return inputs as BundleInputs;
  } catch {
    return undefined;
  }
}

/**
 * The files that the bundles of the project read, from the inputs files in
 * `dist/.bundles`, as absolute paths, sorted.
 */
export function bundleInputFiles(
  root: string = realRoot(projectRoot()),
): string[] {
  const dir = path.join(filePaths.dist.dir(), ".bundles");
  let ids: string[];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = new Set<string>();
  for (const id of ids) {
    for (const file of Object.keys(readInputs(id)?.files ?? {})) {
      files.add(path.resolve(root, file));
    }
  }
  return [...files].sort();
}

/**
 * A hash of everything about a bundle that decides its output or the check
 * of it, other than the files that it reads: the entry, the platform, the
 * sources of `modules`, the full build options, the project's `files` globs
 * and the versions of this package and of Rolldown.
 */
export async function bundleKey(source: BundleSource): Promise<string> {
  const { input, output } = functionBuildOptions(source.platform, source.root);
  const value = {
    entry: source.entry,
    platform: source.platform,
    modules: Object.entries(source.modules).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    input,
    output,
    globs: await projectGlobs(),
    build: manifest.version,
    rolldown: VERSION,
  };
  return sha256Hex(
    JSON.stringify(value, (_key, item) =>
      item instanceof RegExp
        ? item.toString()
        : typeof item === "function"
          ? `function ${item.name}`
          : item,
    ),
  );
}

/**
 * Records the inputs of a build in the bundle's inputs file, unless an input
 * was modified during the build, so that the next plan builds again.
 */
export function recordInputs(id: string, key: string, built: BuiltBundle) {
  if (!built.settled) return;
  writeInputs(id, { key, files: built.files, fileSha256: built.fileSha256 });
}

/**
 * The hash of the bundle's file on disk, when the inputs file shows that the
 * inputs and the file are those of the last build with this key.
 * @param filePath The file that the bundle writes, relative to the project root.
 */
export function currentFileSha256(
  id: string,
  key: string,
  root: string,
  filePath: string,
): string | undefined {
  const inputs = readInputs(id);
  if (!inputs || inputs.key !== key || !sameFiles(inputs.files, root)) {
    return undefined;
  }
  let fileSha256: string;
  try {
    fileSha256 = sha256Base64(
      fs.readFileSync(path.resolve(projectRoot(), filePath)),
    );
  } catch {
    return undefined;
  }
  return fileSha256 === inputs.fileSha256 ? fileSha256 : undefined;
}

type BuildCache = {
  key: string;
  built: Promise<BuiltBundle>;
  /** The inputs of the build, once it has finished. */
  files?: Record<string, string>;
};

// The last build of each bundle in this process, kept while it runs so that
// concurrent calls share it. `deriveParams` runs more than once in a deploy,
// and before the first deploy writes the output only this cache saves a
// build.
const builds = new Map<string, BuildCache>();

/** Forgets the builds of this process. For tests. */
export function clearBuildCache() {
  builds.clear();
}

/**
 * The build from this process's cache, if its inputs have not changed, or a
 * new build. A new build records its inputs.
 */
export function cachedBuild(
  id: string,
  source: BundleSource,
  key: string,
): Promise<BuiltBundle> {
  const cached = builds.get(id);
  if (
    cached?.key === key &&
    (!cached.files || sameFiles(cached.files, source.root))
  ) {
    return cached.built;
  }
  const entry: BuildCache = {
    key,
    built: buildBundle(source).then((built) => {
      entry.files = built.files;
      recordInputs(id, key, built);
      return built;
    }),
  };
  builds.set(id, entry);
  entry.built.catch(() => {
    if (builds.get(id) === entry) builds.delete(id);
  });
  return entry.built;
}
