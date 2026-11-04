import { assertNameSafe, type NameSafe } from "./name-safe";

export const configFileName = "notation.config.ts";

export type NotationConfig = {
  /** Names the app. Part of the deployment ID and of every AWS name. */
  app: string;
  /** The entry file, relative to the directory of the config. */
  entry: string;
  /** The stage to use when a command is given no `--stage`. */
  defaultStage?: string;
  /**
   * Globs, relative to the directory of the config, for the files that can be
   * runtime modules. A matching file is a runtime module only if it exports
   * `resource`. Defaults to `**\/*.fn.ts`.
   */
  runtimeModules?: string | string[];
};

export type NotationConfigInput<App extends string, Stage extends string> = {
  app: NameSafe<App>;
  entry: string;
  defaultStage?: NameSafe<Stage>;
  runtimeModules?: string | string[];
};

/**
 * Declares the project config, the default export of `notation.config.ts`.
 * `app` and `defaultStage` are checked as name-safe at compile time.
 */
export function defineConfig<
  const App extends string,
  const Stage extends string = never,
>(config: NotationConfigInput<App, Stage>): NotationConfig {
  return config as NotationConfig;
}

const configKeys = [
  "app",
  "entry",
  "defaultStage",
  "runtimeModules",
] as const satisfies readonly (keyof NotationConfig)[];

/**
 * Checks a loaded config at runtime, and returns it typed. `fileName` starts
 * every error message.
 */
export function parseConfig(
  value: unknown,
  fileName: string = configFileName,
): NotationConfig {
  const prefix = `Invalid ${fileName}:`;
  const fail = (message: string): never => {
    throw new Error(`${prefix} ${message}`);
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

  const { app, entry, defaultStage, runtimeModules } = value;
  assertNameSafe(app, `${prefix} app`);

  if (typeof entry !== "string" || entry === "") {
    fail("entry must be a path to an entry file");
  }

  if (defaultStage !== undefined)
    assertNameSafe(defaultStage, `${prefix} defaultStage`);

  if (runtimeModules !== undefined) {
    const globs = [runtimeModules].flat();
    if (
      globs.length === 0 ||
      !globs.every((glob) => typeof glob === "string" && glob !== "")
    ) {
      fail("runtimeModules must be a glob or a non-empty array of globs");
    }
  }

  return value as NotationConfig;
}

export const defaultRuntimeModules = ["**/*.fn.ts"];

/** The config's `runtimeModules` as an array, or the default globs. */
export function resolveRuntimeModules(config: NotationConfig): string[] {
  if (config.runtimeModules === undefined) return defaultRuntimeModules;
  return [config.runtimeModules].flat();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
