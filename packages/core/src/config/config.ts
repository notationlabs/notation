import { assertNameSafe, type IsNameSafe, type NameSafe } from "./name-safe";

export const configFileName = "notation.config.ts";

export type NotationConfig = {
  /** Names the app. Part of the deployment ID of every entry. */
  app: string;
  /** Maps entry names to entry files, relative to the project root. */
  entries: Record<string, string>;
  /** Glob, or globs, of the runtime modules, relative to the project root. */
  runtimeModules?: string | string[];
  /** The stage to use when a command is given no `--stage`. */
  defaultStage?: string;
};

type EntriesInput<E extends Record<string, string>> = {
  [K in keyof E]: K extends string
    ? IsNameSafe<K> extends true
      ? E[K]
      : `"${K}" is not name-safe`
    : never;
};

export type NotationConfigInput<
  App extends string,
  Entries extends Record<string, string>,
  Stage extends string,
> = {
  app: NameSafe<App>;
  entries: EntriesInput<Entries>;
  runtimeModules?: string | string[];
  defaultStage?: NameSafe<Stage>;
};

/**
 * Declares the project config, the default export of `notation.config.ts`.
 * `app`, the entry names and `defaultStage` are checked as name-safe at
 * compile time.
 */
export function defineConfig<
  const App extends string,
  const Entries extends Record<string, string>,
  const Stage extends string = never,
>(config: NotationConfigInput<App, Entries, Stage>): NotationConfig {
  return config as NotationConfig;
}

const configKeys = [
  "app",
  "entries",
  "runtimeModules",
  "defaultStage",
] as const satisfies readonly (keyof NotationConfig)[];

/** Checks a loaded config at runtime, and returns it typed. */
export function parseConfig(value: unknown): NotationConfig {
  const fail = (message: string): never => {
    throw new Error(`Invalid ${configFileName}: ${message}`);
  };
  if (!isRecord(value)) return fail("the default export must be an object");

  const unknownKeys = Object.keys(value).filter(
    (key) => !(configKeys as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    fail(
      `unknown ${unknownKeys.length === 1 ? "key" : "keys"} ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}. Known keys: ${configKeys.join(", ")}`,
    );
  }

  const { app, entries, runtimeModules, defaultStage } = value;
  assertNameSafe(app, "app");

  if (!isRecord(entries)) return fail("entries must be an object");
  const entryNames = Object.keys(entries);
  if (entryNames.length === 0) fail("entries must name at least one entry");
  for (const name of entryNames) {
    assertNameSafe(name, "entry name");
    if (typeof entries[name] !== "string" || entries[name] === "") {
      fail(`entry ${JSON.stringify(name)} must be a path to an entry file`);
    }
  }

  if (
    runtimeModules !== undefined &&
    typeof runtimeModules !== "string" &&
    !(
      Array.isArray(runtimeModules) &&
      runtimeModules.every((glob) => typeof glob === "string")
    )
  ) {
    fail("runtimeModules must be a glob or an array of globs");
  }

  if (defaultStage !== undefined) assertNameSafe(defaultStage, "defaultStage");

  return value as NotationConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
