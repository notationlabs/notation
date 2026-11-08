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
   * Globs, relative to the directory of the config, for the runtime files.
   * Defaults to `runtime/**\/*.ts`. Deploy includes each runtime file that
   * calls a declaration function, such as `$lambda`, even if infra doesn't
   * import it.
   */
  runtimeModules?: string | string[];
  /**
   * Globs, relative to the directory of the config, for modules that are
   * shared: both builds bundle them as written. A shared module can't
   * declare a function or resources, or import an infra or runtime module.
   * Defaults to none.
   */
  sharedModules?: string | string[];
};

export type NotationConfigInput<App extends string, Stage extends string> = {
  app: NameSafe<App>;
  entry: string;
  defaultStage?: NameSafe<Stage>;
  runtimeModules?: string | string[];
  sharedModules?: string | string[];
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
  "sharedModules",
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

  const { app, entry, defaultStage, runtimeModules, sharedModules } = value;
  assertNameSafe(app, `${prefix} app`);

  if (typeof entry !== "string" || entry === "") {
    fail("entry must be a path to an entry file");
  }

  if (defaultStage !== undefined)
    assertNameSafe(defaultStage, `${prefix} defaultStage`);

  for (const [key, globs] of [
    ["runtimeModules", runtimeModules],
    ["sharedModules", sharedModules],
  ] as const) {
    if (globs === undefined) continue;
    const list = [globs].flat();
    if (
      list.length === 0 ||
      !list.every((glob) => typeof glob === "string" && glob !== "")
    ) {
      fail(`${key} must be a glob or a non-empty array of globs`);
    }
  }

  return value as NotationConfig;
}

export const defaultRuntimeModules = ["runtime/**/*.ts"];

/** The config's `runtimeModules` as an array, or the default globs. */
export function resolveRuntimeModules(config: NotationConfig): string[] {
  if (config.runtimeModules === undefined) return defaultRuntimeModules;
  return [config.runtimeModules].flat();
}

/** The config's `sharedModules` as an array. Defaults to none. */
export function resolveSharedModules(config: NotationConfig): string[] {
  return config.sharedModules === undefined
    ? []
    : [config.sharedModules].flat();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
