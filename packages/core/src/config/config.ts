import { assertNameSafe, type NameSafe } from "./name-safe";

export const configFileName = "notation.config.ts";

export type NotationConfig = {
  /** Names the app. Part of the deployment ID and of every AWS name. */
  app: string;
  /** The entry file, relative to the directory of the config. */
  entry: string;
  /** The stage to use when a command is given no `--stage`. */
  defaultStage?: string;
};

export type NotationConfigInput<App extends string, Stage extends string> = {
  app: NameSafe<App>;
  entry: string;
  defaultStage?: NameSafe<Stage>;
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

  const { app, entry, defaultStage } = value;
  assertNameSafe(app, `${prefix} app`);

  if (typeof entry !== "string" || entry === "") {
    fail("entry must be a path to an entry file");
  }

  if (defaultStage !== undefined)
    assertNameSafe(defaultStage, `${prefix} defaultStage`);

  return value as NotationConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
