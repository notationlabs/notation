import { fileURLToPath } from "node:url";
import { parse } from "es-module-lexer";
import { infraModuleSource, isProvider } from "src/testing/served";

type ResolvedId = { id: string; external?: boolean | "absolute" | "relative" };

type PluginContext = {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean },
  ): Promise<ResolvedId | null>;
  error(message: string): never;
};

/** The parts of a Vite plugin that the Notation plugin uses. */
export type NotationTestingPlugin = {
  name: string;
  transform(code: string, id: string): { code: string; map: null } | undefined;
  resolveId(
    this: PluginContext,
    source: string,
    importer: string | undefined,
  ): Promise<ResolvedId | string | undefined>;
  load(id: string): string | undefined;
};

const prefix = "notation-infra:";
const virtualPrefix = `\0${prefix}`;
const bindingModule = fileURLToPath(new URL("../index.js", import.meta.url));
const scriptFile = /\.[cm]?[jt]sx?$/;
const infraOptions =
  /^\{\s*["']?with["']?\s*:\s*\{[^}]*\btype["']?\s*:\s*["'`]infra["'`]/;

const withoutQuery = (id: string) => id.replace(/[?#].*$/, "");

/**
 * A Vite plugin that lets Vitest import runtime modules as Notation's loader
 * hook does for Node. A `type: "infra"` import of an infra module serves the
 * values set with `setOutputs`, and one of a provider, such as
 * `@notation/aws/lambda`, resolves to its runtime half.
 *
 * Vite doesn't pass import attributes to plugins, so the plugin marks each
 * `type: "infra"` specifier with a prefix before Vite resolves it. This
 * covers static imports, and dynamic imports whose specifier is a string.
 */
export function notationTesting(): NotationTestingPlugin {
  return {
    name: "notation-testing",
    transform(code, id) {
      if (!scriptFile.test(withoutQuery(id)) || !code.includes("infra")) {
        return;
      }
      if (id.split("/").includes("node_modules")) return;
      const [imports] = parse(code);
      let out = "";
      let cursor = 0;
      for (const imp of imports) {
        if (imp.n === undefined) continue;
        if (imp.d === -1) {
          if (!imp.at?.some(([k, v]) => k === "type" && v === "infra")) {
            continue;
          }
          out += code.slice(cursor, imp.s) + prefix + imp.n;
        } else {
          // es-module-lexer doesn't parse a dynamic import's attributes, so
          // its options are matched as text. `s` and `e` take in the quotes.
          if (imp.a === -1 || !infraOptions.test(code.slice(imp.a, imp.se))) {
            continue;
          }
          out += code.slice(cursor, imp.s) + JSON.stringify(prefix + imp.n);
        }
        cursor = imp.e;
      }
      if (cursor === 0) return;
      return { code: out + code.slice(cursor), map: null };
    },
    async resolveId(source, importer) {
      if (!source.startsWith(prefix)) return;
      const specifier = source.slice(prefix.length);
      const target = await this.resolve(specifier, importer, {
        skipSelf: true,
      });
      if (!target) {
        return this.error(`Can't resolve ${specifier} from ${importer}.`);
      }
      const file = withoutQuery(target.id);
      if (!importer || !isProvider(specifier, file, withoutQuery(importer))) {
        return virtualPrefix + file;
      }
      const half = await this.resolve(`${specifier}.fn`, importer, {
        skipSelf: true,
      });
      if (!half) {
        return this.error(
          `${specifier} is imported with { type: "infra" }, but its runtime half, ${specifier}.fn, can't be resolved.`,
        );
      }
      return half;
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return;
      return infraModuleSource(id.slice(virtualPrefix.length), bindingModule);
    },
  };
}
