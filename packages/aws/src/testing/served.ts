import fs from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { initSync, parse } from "es-module-lexer";

initSync();

const configFileName = "notation.config.ts";
const roots = new Map<string, string>();

/**
 * The project root of a file, as the compiler sees it: the nearest directory
 * above the file that holds `notation.config.ts`. `notation` commands run in
 * that directory, and key each value that runtime code reads by its path
 * from there, so a `package.json` in between, such as a nested package's,
 * doesn't end the search. Without a config above the file, the root is the
 * nearest directory with a `package.json`, or else the file's directory.
 */
export function projectRootOf(file: string): string {
  const start = path.dirname(path.resolve(file));
  let root = roots.get(start);
  if (root !== undefined) return root;
  let nearestPackage: string | undefined;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, configFileName))) {
      root = dir;
      break;
    }
    if (nearestPackage === undefined) {
      if (fs.existsSync(path.join(dir, "package.json"))) nearestPackage = dir;
    }
    if (dir === path.dirname(dir)) {
      root = nearestPackage ?? start;
      break;
    }
  }
  roots.set(start, root);
  return root;
}

/** The module part of an output key, such as `infra/orders`. */
export function outputModule(file: string): string {
  return path
    .relative(projectRootOf(file), file)
    .split(path.sep)
    .join("/")
    .replace(/\.[cm]?[jt]sx?$/, "");
}

export function isBare(specifier: string): boolean {
  return !/^(\.{1,2}(\/|$)|\/|#|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(specifier);
}

/**
 * Whether a `type: "infra"` import names a provider's infra half, such as
 * `@notation/aws/lambda`, and not an infra module of the project. A provider
 * is a package: a bare specifier that resolves into `node_modules` or outside
 * the importer's project.
 */
export function isProvider(
  specifier: string,
  file: string,
  importer: string,
): boolean {
  if (!isBare(specifier)) return false;
  // Vitest gives ids with "/" on Windows too, so both separators split.
  if (file.split(/[\\/]/).includes("node_modules")) return true;
  const relative = path.relative(projectRootOf(importer), file);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

const extensions = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];

const isFile = (file: string) =>
  fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

// Finds a file as TypeScript's bundler resolution does: with no extension,
// `.js` written for `.ts`, or a directory's index.
function findFile(base: string): string | undefined {
  const candidates = [
    base,
    ...extensions.map((ext) => base + ext),
    ...extensions.map((ext) => path.join(base, `index${ext}`)),
  ];
  if (/\.[cm]?js$/.test(base)) {
    candidates.push(base.replace(/js$/, "ts"), base.replace(/\.js$/, ".tsx"));
  }
  return candidates.find(isFile);
}

/**
 * Resolves an import of a project file, which Node can't resolve without an
 * extension. A bare specifier resolves from the project root, as the `paths`
 * of a tsconfig, such as `"infra/*": ["./infra/*"]`, map it.
 */
export function resolveLocal(
  specifier: string,
  importer: string,
): string | undefined {
  if (specifier.startsWith(".")) {
    return findFile(path.resolve(path.dirname(importer), specifier));
  }
  if (path.isAbsolute(specifier)) return findFile(specifier);
  if (isBare(specifier)) {
    return findFile(path.join(projectRootOf(importer), specifier));
  }
  return undefined;
}

// es-module-lexer reads most TypeScript as it is. Node's type stripping is
// the fallback, since it logs an experimental warning.
function lex(source: string) {
  try {
    return parse(source);
  } catch {
    const strip = (nodeModule as any).stripTypeScriptTypes as (
      code: string,
      options: { mode: "transform" },
    ) => string;
    return parse(strip(source, { mode: "transform" }));
  }
}

/**
 * The names that a module exports, read from its source without running it.
 * `export * from` a project file adds that file's names. Type-only exports
 * can add extra names, which are harmless.
 */
export function exportNames(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = fs.readFileSync(file, "utf8");
  const [imports, exports] = lex(source);
  const names = new Set(exports.map((e) => e.n));
  for (const imp of imports) {
    if (imp.d !== -1 || imp.n === undefined) continue;
    if (!/^export\s*\*\s*from/.test(source.slice(imp.ss, imp.se))) continue;
    const target = resolveLocal(imp.n, file);
    if (!target) continue;
    for (const name of exportNames(target, seen)) {
      if (name !== "default") names.add(name);
    }
  }
  return [...names];
}

/**
 * The source of the module that a test sees in place of an infra module. Each
 * export reads the values stubbed with `stubOutputs`.
 * @param bindingModule The URL or path of `@notation/aws/testing`.
 */
export function infraModuleSource(file: string, bindingModule: string): string {
  const module = JSON.stringify(outputModule(file));
  const lines = [
    `import { infraBinding } from ${JSON.stringify(bindingModule)};`,
  ];
  exportNames(file).forEach((name, i) => {
    const exported = /^[A-Za-z_$][\w$]*$/.test(name)
      ? name
      : JSON.stringify(name);
    lines.push(
      `const _${i} = infraBinding(${module}, ${JSON.stringify(name)});`,
      `export { _${i} as ${exported} };`,
    );
  });
  return lines.join("\n");
}
