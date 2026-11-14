import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** The platform that images are built for. Cloudflare runs containers on `linux/amd64` only. */
export const PLATFORM = "linux/amd64";

type Field = (value: string | Buffer) => void;

export type BuildInput = {
  /** The absolute path of the build context directory. */
  context: string;
  /** The absolute path of the Dockerfile. */
  dockerfile: string;
  buildArgs: Record<string, string>;
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
  const field: Field = (value) => {
    // A length before each value, so that two inputs can't join into the
    // same bytes.
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  try {
    field(PLATFORM);
    field(JSON.stringify(Object.entries(input.buildArgs).sort()));
    field(await fs.readFile(input.dockerfile));
    await walk(input.context, "", field);
  } catch (error) {
    throw new Error(
      `Could not read the build context ${input.context} and the Dockerfile ${input.dockerfile}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return hash.digest("hex");
}

/**
 * Adds each file, link and directory under `root/relative` to the hash,
 * sorted by name. Paths use forward slashes, so the hash is the same on
 * Windows.
 */
async function walk(root: string, relative: string, field: Field) {
  const directory = path.join(root, relative);
  const names = (await fs.readdir(directory)).sort();
  for (const name of names) {
    if (name === ".git") continue;
    const entryPath = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, name);
    const stat = await fs.lstat(absolute);
    // Docker copies the permission bits, so a change to them changes the
    // image.
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) {
      field("link");
      field(entryPath);
      field(await fs.readlink(absolute));
    } else if (stat.isDirectory()) {
      field(`dir ${mode}`);
      field(entryPath);
      await walk(root, entryPath, field);
    } else if (stat.isFile()) {
      field(`file ${mode}`);
      field(entryPath);
      field(await fs.readFile(absolute));
    }
  }
}
