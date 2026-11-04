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

export type RenderedTypes = { contents: string; warnings: string[] };

/**
 * Makes the contents of `notation-env.d.ts`: one block per attributed import
 * specifier, then a catch-all for each attribute and for `./` and `../`.
 *
 * TypeScript gives an import the declaration whose pattern has the longest
 * prefix, so each block's pattern is its specifier followed by `*`. A
 * relative pattern without `*` is ignored.
 *
 * A relative specifier that doesn't resolve, or that names different modules
 * from different directories, gets a block with an error type and a warning.
 * No pattern can tell two modules with one specifier apart.
 */
export function renderTypes(
  root: string,
  imports: AttributedImport[],
): RenderedTypes {
  const blocks = new Map<
    string,
    {
      type: AttributeType;
      specifier: string;
      // Each importer's target, or undefined if the specifier doesn't resolve.
      importers: Map<string, string | undefined>;
    }
  >();
  for (const entry of imports) {
    const key = `${entry.type}\0${entry.specifier}`;
    let block = blocks.get(key);
    if (!block) {
      block = {
        type: entry.type,
        specifier: entry.specifier,
        importers: new Map(),
      };
      blocks.set(key, block);
    }
    const target = entry.resolved
      ? moduleSpecifier(root, entry.resolved)
      : isRelative(entry.specifier)
        ? undefined
        : entry.specifier;
    block.importers.set(relativePath(root, entry.importer), target);
  }

  const lines = [`// Generated by \`notation types\`. Do not edit.`, ``];
  const warnings: string[] = [];
  const sorted = [...blocks.values()].sort(
    (a, b) =>
      a.type.localeCompare(b.type) || a.specifier.localeCompare(b.specifier),
  );
  for (const { type, specifier, importers } of sorted) {
    const declare = (view: string) =>
      lines.push(
        `declare module ${JSON.stringify(`${specifier}*`)} with { type: ${JSON.stringify(type)} } {`,
        `  const view: ${view};`,
        `  export = view;`,
        `}`,
      );
    const errorView = (message: string, fix: string) =>
      `{ readonly [name: string]: { readonly ${JSON.stringify(message)}: ${JSON.stringify(fix)} } }`;
    const unresolved = [...importers]
      .filter(([, target]) => target === undefined)
      .map(([importer]) => importer)
      .sort()
      .join(", ");
    const targets = new Set(importers.values());
    if (unresolved) {
      warnings.push(
        `The import "${specifier}" with { type: "${type}" } in ${unresolved} doesn't resolve to a file.`,
      );
      declare(
        errorView(
          `"${specifier}" in ${unresolved} doesn't resolve to a file`,
          "check the path",
        ),
      );
    } else if (targets.size > 1) {
      const files = [...importers.keys()].sort().join(", ");
      warnings.push(
        `The import "${specifier}" with { type: "${type}" } names different modules in ${files}. ` +
          `A declaration matches an import by its specifier, so it can't tell them apart. ` +
          `Import one of them with a different specifier, e.g. one that goes up one more directory.`,
      );
      declare(
        errorView(
          `"${specifier}" names different modules in ${files}`,
          "use a different specifier in one of the files",
        ),
      );
    } else {
      const [target] = targets;
      declare(
        `import(${JSON.stringify(viewsModule)}).${views[type]}<typeof import(${JSON.stringify(target)})>`,
      );
    }
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
  return { contents: lines.join("\n") + "\n", warnings };
}

export type WrittenTypes = { changed: boolean; warnings: string[] };

/**
 * Writes `notation-env.d.ts` at the project root. The file is rewritten only
 * when its contents change, so an editor or `tsc --watch` doesn't recheck
 * for nothing.
 */
export async function writeTypes(root: string): Promise<WrittenTypes> {
  const imports = await findAttributedImports(await listSourceFiles(root));
  const { contents, warnings } = renderTypes(root, imports);
  const file = path.join(root, typesFileName);
  if (existsSync(file) && readFileSync(file, "utf8") === contents) {
    return { changed: false, warnings };
  }
  writeFileSync(file, contents);
  return { changed: true, warnings };
}

/**
 * Writes `notation-env.d.ts` and logs its warnings. It logs a failure as a
 * warning and doesn't throw it, because the build doesn't read the file.
 */
export async function writeTypesOrWarn(
  root: string,
  logger: Logger = defaultLogger,
) {
  try {
    const { warnings } = await writeTypes(root);
    for (const warning of warnings) logger.warn(warning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Writing ${typesFileName} failed:\n${message}`);
  }
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
  // A warning is logged again only after a run without it.
  let warned = new Set<string>();
  const run = async () => {
    try {
      const { changed, warnings } = await writeTypes(root);
      if (changed) logger.info(`Wrote ${typesFileName}`);
      for (const warning of warnings) {
        if (!warned.has(warning)) logger.warn(warning);
      }
      warned = new Set(warnings);
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

function relativePath(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/");
}

// The specifier that names `file` from the project root. TypeScript maps a
// `.js` extension to the `.ts` file in every module resolution mode.
function moduleSpecifier(root: string, file: string) {
  const relative = relativePath(root, file);
  const withJs = relative
    .replace(/\.[jt]sx?$/, ".js")
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs");
  return withJs.startsWith(".") ? withJs : `./${withJs}`;
}
