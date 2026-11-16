import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseSync } from "rolldown/utils";
import { unwrap, type Node } from "../ast";

export const sha256Hex = (data: string | Uint8Array) =>
  crypto.createHash("sha256").update(data).digest("hex");

export const sha256Base64 = (data: string | Uint8Array) =>
  crypto.createHash("sha256").update(data).digest("base64");

/** The hex SHA-256 of a file, or undefined if it can't be read. */
export function hashFile(file: string): string | undefined {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** A path relative to `root`, with `/` separators. */
const relativeTo = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join("/");

const lockfiles = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/**
 * The files whose contents decide a build's output, with a hash of each, by
 * path relative to `root`, sorted. These are the modules that the build
 * read, the nearest `package.json` and `tsconfig.json` of each module, each
 * tsconfig that one of those extends or references, and the lockfile of the
 * project.
 */
export function collectInputs(
  moduleIds: Iterable<string>,
  root: string,
): Record<string, string> {
  const files = new Set<string>();
  const nearest = new Map<string, string | undefined>();
  const nearestFile = (dir: string, name: string): string | undefined => {
    const cacheKey = `${dir}\0${name}`;
    if (nearest.has(cacheKey)) return nearest.get(cacheKey);
    const candidate = path.join(dir, name);
    const parent = path.dirname(dir);
    const found = fs.existsSync(candidate)
      ? candidate
      : parent === dir
        ? undefined
        : nearestFile(parent, name);
    nearest.set(cacheKey, found);
    return found;
  };

  for (const id of moduleIds) {
    // Generated modules, such as `\0rolldown/runtime.js` and the modules of
    // `modules`, and built-ins have no file.
    if (id.startsWith("\0") || !path.isAbsolute(id)) continue;
    files.add(id);
    const dir = path.dirname(id);
    const manifest = nearestFile(dir, "package.json");
    if (manifest) files.add(manifest);
    const tsconfig = nearestFile(dir, "tsconfig.json");
    if (tsconfig) addTsconfig(tsconfig, files);
  }
  for (let dir = root; ; dir = path.dirname(dir)) {
    const found = lockfiles
      .map((name) => path.join(dir, name))
      .filter((file) => fs.existsSync(file));
    if (found.length > 0) {
      for (const file of found) files.add(file);
      break;
    }
    if (dir === path.dirname(dir)) break;
  }

  const hashes: Record<string, string> = {};
  for (const file of [...files].map((file) => relativeTo(root, file)).sort()) {
    const hash = hashFile(path.resolve(root, file));
    if (hash !== undefined) hashes[file] = hash;
  }
  return hashes;
}

// Adds a tsconfig, each file that it extends and each project that it
// references, directly or through another.
function addTsconfig(file: string, files: Set<string>) {
  if (files.has(file)) return;
  files.add(file);
  const dir = path.dirname(file);
  const config = readTsconfig(file);
  for (const specifier of config.extends) {
    const resolved = resolveExtends(specifier, dir);
    if (resolved) addTsconfig(resolved, files);
  }
  for (const reference of config.references) {
    const resolved = resolveReference(reference, dir);
    if (resolved) addTsconfig(resolved, files);
  }
}

// The `extends` and the `path` of each of the `references` of a tsconfig. A
// tsconfig can hold comments and trailing commas, which a JavaScript
// expression can too, so it is parsed as one.
function readTsconfig(file: string): {
  extends: string[];
  references: string[];
} {
  const none = { extends: [], references: [] };
  let body: Node[];
  try {
    const source = `(${fs.readFileSync(file, "utf8")}\n)`;
    const result = parseSync(file, source, { lang: "js" });
    if (result.errors.length > 0) return none;
    body = result.program.body as unknown as Node[];
  } catch {
    return none;
  }
  const config = body[0] && unwrap(body[0].expression);
  if (config?.type !== "ObjectExpression") return none;
  const extendsValue = propertyValue(config, "extends");
  const extendsItems =
    extendsValue?.type === "ArrayExpression"
      ? extendsValue.elements
      : [extendsValue];
  const referencesValue = propertyValue(config, "references");
  const referenceItems =
    referencesValue?.type === "ArrayExpression"
      ? referencesValue.elements.map(
          (item: Node | null) =>
            item?.type === "ObjectExpression" && propertyValue(item, "path"),
        )
      : [];
  return {
    extends: strings(extendsItems),
    references: strings(referenceItems),
  };
}

function propertyValue(object: Node, key: string): Node | undefined {
  const property = object.properties.find(
    (node: Node) =>
      node.type === "Property" &&
      node.key.type === "Literal" &&
      node.key.value === key,
  );
  return property && unwrap(property.value);
}

const strings = (items: (Node | null | undefined | false)[]): string[] =>
  items
    .filter((item) => item && typeof item.value === "string")
    .map((item) => (item as Node).value as string);

// Resolves the `path` of a project reference, relative to the tsconfig. A
// directory means the `tsconfig.json` in it.
function resolveReference(reference: string, dir: string): string | undefined {
  const resolved = path.resolve(dir, reference);
  const stats = fs.statSync(resolved, { throwIfNoEntry: false });
  if (stats?.isDirectory()) {
    const file = path.join(resolved, "tsconfig.json");
    return fs.existsSync(file) ? file : undefined;
  }
  return stats?.isFile() ? resolved : undefined;
}

// Resolves `extends` as TypeScript does: a path relative to the tsconfig, or
// a package, with `.json` and `/tsconfig.json` tried after the name.
function resolveExtends(specifier: string, dir: string): string | undefined {
  const candidates = [
    specifier,
    `${specifier}.json`,
    `${specifier}/tsconfig.json`,
  ];
  const isPath = specifier.startsWith(".") || path.isAbsolute(specifier);
  if (isPath) {
    return candidates
      .map((candidate) => path.resolve(dir, candidate))
      .find((candidate) =>
        fs.statSync(candidate, { throwIfNoEntry: false })?.isFile(),
      );
  }
  const require = createRequire(path.join(dir, "tsconfig.json"));
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {}
  }
  return undefined;
}

/**
 * Whether a file was modified between `started`, in milliseconds since the
 * epoch, and now. A file that can't be read counts as modified. A file whose
 * mtime is ahead of the clock doesn't, as it would count on every build.
 */
export function modifiedSince(
  files: Record<string, string>,
  root: string,
  started: number,
): boolean {
  const stats = Object.keys(files).map((file) =>
    fs.statSync(path.resolve(root, file), { throwIfNoEntry: false }),
  );
  // Taken after the stats, so that a file modified while they run counts.
  const finished = Date.now();
  return stats.some(
    (stat) => !stat || (stat.mtimeMs >= started && stat.mtimeMs <= finished),
  );
}

/** Whether each file still has the recorded hash. */
export function sameFiles(files: Record<string, string>, root: string) {
  return Object.entries(files).every(
    ([file, hash]) => hashFile(path.resolve(root, file)) === hash,
  );
}
