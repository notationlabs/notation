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
   * Globs, relative to the directory of the config, that give each file its
   * kind of module. Each kind that isn't set keeps its default, which is the
   * folder of the same name, such as `infra/**`.
   */
  files?: ModuleFiles;
};

export const moduleKinds = ["infra", "runtime", "shared"] as const;

export type ModuleKind = (typeof moduleKinds)[number];

/**
 * A glob or an array of globs for each kind of module. A glob that starts
 * with `!` excludes the files that it matches.
 */
export type ModuleFiles = { [Kind in ModuleKind]?: string | string[] };

/** The globs that the config sets, by kind, each as an array. */
export type ModuleGlobs = { [Kind in ModuleKind]?: string[] };

export const defaultModuleGlobs: Required<ModuleGlobs> = {
  infra: ["infra/**"],
  runtime: ["runtime/**"],
  shared: ["shared/**"],
};

export type NotationConfigInput<App extends string, Stage extends string> = {
  app: NameSafe<App>;
  entry: string;
  defaultStage?: NameSafe<Stage>;
  files?: ModuleFiles;
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
  "files",
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

  const { app, entry, defaultStage, files } = value;
  assertNameSafe(app, `${prefix} app`);

  if (typeof entry !== "string" || entry === "") {
    fail("entry must be a path to an entry file");
  }

  if (defaultStage !== undefined)
    assertNameSafe(defaultStage, `${prefix} defaultStage`);

  if (files !== undefined) parseFiles(files, fail);

  return value as NotationConfig;
}

function parseFiles(files: unknown, fail: (message: string) => never) {
  if (!isRecord(files)) {
    fail(`files must be an object with the keys ${moduleKinds.join(", ")}`);
  }
  for (const [kind, value] of Object.entries(files)) {
    if (!(moduleKinds as readonly string[]).includes(kind)) {
      fail(
        `unknown key "${kind}" in files. Known keys: ${moduleKinds.join(", ")}`,
      );
    }
    if (value === undefined) continue;
    const globs: unknown[] = [value].flat();
    if (
      !globs.every(
        (glob): glob is string => typeof glob === "string" && glob !== "",
      )
    ) {
      return fail(`files.${kind} must be a glob or an array of globs`);
    }
    if (globs.length > 0 && globs.every((glob) => glob.startsWith("!"))) {
      fail(
        `files.${kind} has only globs that start with "!", so it matches no file. Add a glob for the files to include`,
      );
    }
  }
}

/**
 * The globs that the config's `files` sets, each as an array. A kind that
 * the config doesn't set is left out, so that the build uses its default.
 */
export function resolveModuleGlobs(config: NotationConfig): ModuleGlobs {
  const globs: ModuleGlobs = {};
  for (const kind of moduleKinds) {
    const value = config.files?.[kind];
    if (value !== undefined) globs[kind] = [value].flat();
  }
  return globs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
