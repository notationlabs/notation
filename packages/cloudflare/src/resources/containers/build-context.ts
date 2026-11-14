import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Changing what goes into the hash changes the tag of every image, so each
// image is built again once. Bump the version when the input changes.
const HASH_VERSION = "1";

const SKIPPED_NAMES = new Set([".git"]);

export type BuildInput = {
  /** The absolute path of the build context directory. */
  context: string;
  /** The absolute path of the Dockerfile. */
  dockerfile: string;
  buildArgs: Record<string, string>;
  platform: string;
};

/**
 * Returns a hex SHA-256 of what a build uses: the path, mode and bytes of
 * each file in the context, the target of each symbolic link, the
 * Dockerfile, the build args and the platform. Each `.git` directory is
 * skipped. `.dockerignore` is not read, so a change to a file that it
 * excludes also changes the hash.
 */
export async function hashBuildInput(input: BuildInput): Promise<string> {
  const hash = crypto.createHash("sha256");
  const field = (value: string | Buffer) => {
    // A length before each value, so that two inputs can't join into the
    // same bytes.
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  field(HASH_VERSION);
  field(input.platform);
  field(JSON.stringify(Object.entries(input.buildArgs).sort()));
  field(await readInput(input.dockerfile, "Dockerfile"));
  const stat = await statInput(input.context, "build context");
  if (!stat.isDirectory()) {
    throw new Error(`The build context ${input.context} is not a directory`);
  }
  for await (const entry of walk(input.context, "")) {
    field(entry.type);
    field(entry.path);
    field(entry.data);
  }
  return hash.digest("hex");
}

type Entry = { type: string; path: string; data: string | Buffer };

/**
 * Yields each file, link and directory under `root/relative`, sorted by
 * name. Paths use forward slashes, so the hash is the same on Windows.
 */
async function* walk(root: string, relative: string): AsyncGenerator<Entry> {
  const directory = path.join(root, relative);
  const names = (await fs.readdir(directory)).sort();
  for (const name of names) {
    if (SKIPPED_NAMES.has(name)) continue;
    const entryPath = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, name);
    const stat = await fs.lstat(absolute);
    // Docker copies the permission bits, so a change to them changes the
    // image.
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) {
      yield {
        type: "link",
        path: entryPath,
        data: await fs.readlink(absolute),
      };
    } else if (stat.isDirectory()) {
      yield { type: `dir ${mode}`, path: entryPath, data: "" };
      yield* walk(root, entryPath);
    } else if (stat.isFile()) {
      yield {
        type: `file ${mode}`,
        path: entryPath,
        data: await fs.readFile(absolute),
      };
    }
  }
}

async function readInput(file: string, noun: string): Promise<Buffer> {
  await statInput(file, noun);
  return await fs.readFile(file);
}

async function statInput(file: string, noun: string) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The ${noun} ${file} was not found`, { cause: error });
    }
    throw error;
  }
}
