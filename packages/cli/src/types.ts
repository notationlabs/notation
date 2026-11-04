import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import esbuild from "esbuild";
import { defaultLogger, type Logger } from "./logger";

export const typesFileName = "notation-env.d.ts";

const attributeTypes = ["infra", "runtime"] as const;
type AttributeType = (typeof attributeTypes)[number];

const views: Record<AttributeType, string> = {
  infra: "RuntimeView",
  runtime: "InfraView",
};

const viewsModule = "@notation/core/types";

export type AttributedImport = {
  /** The absolute path of the importing file. */
  importer: string;
  specifier: string;
  type: AttributeType;
  /** The absolute path of the imported file, for a relative specifier. */
  resolved?: string;
};

export class AmbiguousSpecifierError extends Error {
  constructor(type: AttributeType, specifier: string, importers: string[]) {
    super(
      `The import "${specifier}" with { type: "${type}" } names different modules in ${importers.join(", ")}. ` +
        `A declaration matches an import by its specifier, so it can't tell them apart. ` +
        `Import one of them with a different specifier, e.g. one that goes up one more directory.`,
    );
    this.name = "AmbiguousSpecifierError";
  }
}

const sourceExtensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const ignoredDirs = new Set(["node_modules", "dist"]);
const mayHaveAttribute =
  /\bwith\s*:?\s*\{[^}]*\btype\s*:\s*["'](?:infra|runtime)["']/;

/** Lists the source files of the project, outside node_modules, dist and dot directories. */
export async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) await walk(full);
      } else if (
        sourceExtensions.test(entry.name) &&
        !/\.d\.[cm]?ts$/.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * Finds every import in `files` with `{ type: "infra" }` or
 * `{ type: "runtime" }`. esbuild parses each file, and every import is left
 * external, so no imported file is read.
 */
export async function findAttributedImports(
  files: string[],
): Promise<AttributedImport[]> {
  const candidates: string[] = [];
  for (const file of files) {
    if (mayHaveAttribute.test(await readFile(file, "utf8"))) {
      candidates.push(file);
    }
  }
  if (candidates.length === 0) return [];

  const found: AttributedImport[] = [];
  const resolving = Symbol("resolving");
  await esbuild.build({
    entryPoints: candidates,
    bundle: true,
    write: false,
    outdir: "out",
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "notation-types",
        setup(build) {
          build.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData === resolving) return undefined;
            if (args.kind === "entry-point") return undefined;
            const type = args.with?.type;
            if (!isAttributeType(type)) return { external: true };
            const entry: AttributedImport = {
              importer: args.importer,
              specifier: args.path,
              type,
            };
            if (isRelative(args.path)) {
              const result = await build.resolve(args.path, {
                importer: args.importer,
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: resolving,
              });
              if (result.errors.length === 0) entry.resolved = result.path;
            }
            found.push(entry);
            return { external: true };
          });
        },
      },
    ],
  });
  return found.sort(
    (a, b) =>
      a.importer.localeCompare(b.importer) ||
      a.specifier.localeCompare(b.specifier),
  );
}

/**
 * Makes the contents of `notation-env.d.ts`: one block per attributed import
 * specifier, then a catch-all for each attribute and for `./` and `../`.
 *
 * TypeScript gives an import the declaration whose pattern has the longest
 * prefix, so each block's pattern is its specifier followed by `*`. A
 * relative pattern without `*` is ignored.
 *
 * Throws `AmbiguousSpecifierError` when one relative specifier names two
 * modules from two directories, since no pattern can tell them apart.
 */
export function renderTypes(root: string, imports: AttributedImport[]) {
  const blocks = new Map<
    string,
    {
      type: AttributeType;
      specifier: string;
      target: string;
      importers: Map<string, string>;
    }
  >();
  for (const entry of imports) {
    if (isRelative(entry.specifier) && entry.resolved === undefined) continue;
    const key = `${entry.type}\0${entry.specifier}`;
    const target = entry.resolved
      ? moduleSpecifier(root, entry.resolved)
      : entry.specifier;
    let block = blocks.get(key);
    if (!block) {
      block = {
        type: entry.type,
        specifier: entry.specifier,
        target,
        importers: new Map(),
      };
      blocks.set(key, block);
    }
    block.importers.set(path.relative(root, entry.importer), target);
  }

  const lines = [`// Generated by \`notation types\`. Do not edit.`, ``];
  const sorted = [...blocks.values()].sort(
    (a, b) =>
      a.type.localeCompare(b.type) || a.specifier.localeCompare(b.specifier),
  );
  for (const block of sorted) {
    if (new Set(block.importers.values()).size > 1) {
      throw new AmbiguousSpecifierError(
        block.type,
        block.specifier,
        [...block.importers.keys()].sort(),
      );
    }
    lines.push(
      `declare module ${JSON.stringify(`${block.specifier}*`)} with { type: ${JSON.stringify(block.type)} } {`,
      `  const view: import(${JSON.stringify(viewsModule)}).${views[block.type]}<typeof import(${JSON.stringify(block.target)})>;`,
      `  export = view;`,
      `}`,
    );
  }
  for (const type of attributeTypes) {
    const message = `no generated declaration for this { type: "${type}" } import`;
    for (const prefix of ["./", "../"]) {
      lines.push(
        `declare module ${JSON.stringify(`${prefix}*`)} with { type: ${JSON.stringify(type)} } {`,
        `  const view: { readonly [name: string]: { readonly ${JSON.stringify(message)}: "run notation types" } };`,
        `  export = view;`,
        `}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Writes `notation-env.d.ts` at the project root. The file is rewritten only
 * when its contents change, so an editor or `tsc --watch` doesn't recheck
 * for nothing. Returns whether the file changed.
 */
export async function writeTypes(root: string): Promise<boolean> {
  const imports = await findAttributedImports(await listSourceFiles(root));
  const contents = renderTypes(root, imports);
  const file = path.join(root, typesFileName);
  if (existsSync(file) && readFileSync(file, "utf8") === contents) return false;
  writeFileSync(file, contents);
  return true;
}

export type WatchTypesOptions = { logger?: Logger; debounceMs?: number };

/**
 * Writes `notation-env.d.ts`, then writes it again when a source file is
 * created, deleted, moved or changed. A change that leaves the attributed
 * import specifiers the same leaves the file as it is. Resolves with a
 * function that stops watching, once the watcher is ready.
 */
export async function watchTypes(
  root: string,
  { logger = defaultLogger, debounceMs = 100 }: WatchTypesOptions = {},
): Promise<() => Promise<void>> {
  const run = async () => {
    try {
      if (await writeTypes(root)) logger.info(`Wrote ${typesFileName}`);
    } catch (error) {
      logger.error(error);
    }
  };
  await run();

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (file, stats) => {
      const relative = path.relative(root, file);
      if (relative === "") return false;
      const parts = relative.split(path.sep);
      if (parts.some((part) => part.startsWith(".") || ignoredDirs.has(part))) {
        return true;
      }
      return stats?.isFile() === true && !sourceExtensions.test(file);
    },
  });

  let timeout: NodeJS.Timeout | undefined;
  let running = Promise.resolve();
  watcher.on("all", (_event, file) => {
    if (path.basename(file) === typesFileName) return;
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      running = running.then(run);
    }, debounceMs);
  });
  await new Promise<void>((resolve) => watcher.once("ready", resolve));

  return async () => {
    clearTimeout(timeout);
    await watcher.close();
    await running;
  };
}

function isAttributeType(value: unknown): value is AttributeType {
  return attributeTypes.includes(value as AttributeType);
}

function isRelative(specifier: string) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

// The specifier that names `file` from the project root. TypeScript maps a
// `.js` extension to the `.ts` file in every module resolution mode.
function moduleSpecifier(root: string, file: string) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const withJs = relative
    .replace(/\.[jt]sx?$/, ".js")
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs");
  return withJs.startsWith(".") ? withJs : `./${withJs}`;
}
