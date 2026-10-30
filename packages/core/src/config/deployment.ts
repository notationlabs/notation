import path from "node:path";
import { fromProjectRoot } from "src/utils/paths";
import { configFileName, type NotationConfig } from "./config";
import { assertNameSafe } from "./name-safe";

/** What a deployment is: an entry of an app, deployed to a stage. */
export type DeploymentIdentity = {
  app: string;
  stage: string;
  entry: string;
};

/** A deployment identity with the entry file it deploys. */
export type Deployment = DeploymentIdentity & {
  /** Absolute path of the entry file. */
  entryPoint: string;
};

/** The key of a deployment's state: `<app>:<stage>:<entry>`. */
export function resolveDeploymentId(identity: DeploymentIdentity): string {
  assertNameSafe(identity.app, "app");
  assertNameSafe(identity.stage, "stage");
  assertNameSafe(identity.entry, "entry name");
  return `${identity.app}:${identity.stage}:${identity.entry}`;
}

/**
 * Resolves an entry name to the absolute path of its entry file.
 * @param root The directory of the config. Defaults to the project root.
 */
export function resolveEntryPoint(
  config: NotationConfig,
  entry: string,
  root?: string,
): string {
  if (!Object.hasOwn(config.entries, entry)) {
    const names = Object.keys(config.entries).join(", ");
    throw new Error(
      `No entry named ${JSON.stringify(entry)} in ${configFileName}. Entries: ${names}`,
    );
  }
  const file = config.entries[entry]!;
  return root ? path.resolve(root, file) : fromProjectRoot(file);
}

/**
 * Resolves the deployment of an entry, named in the config, to a stage. The
 * stage falls back to the config's `defaultStage`.
 */
export function resolveDeployment(
  config: NotationConfig,
  opts: {
    entry: string;
    stage?: string;
    /** The directory of the config. Defaults to the project root. */
    root?: string;
  },
): Deployment {
  const entryPoint = resolveEntryPoint(config, opts.entry, opts.root);
  const stage = opts.stage ?? config.defaultStage;
  if (stage === undefined) {
    throw new Error(
      `No stage given. Pass --stage, or set defaultStage in ${configFileName}`,
    );
  }
  assertNameSafe(stage, "stage");
  return { app: config.app, stage, entry: opts.entry, entryPoint };
}
