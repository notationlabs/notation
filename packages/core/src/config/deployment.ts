import fs from "node:fs";
import path from "node:path";
import { configPath, fromProjectRoot } from "src/utils/paths";
import { assertNameSafe, isNameSafe } from "./name-safe";
import type { Project } from "./project";

/** What a deployment is: an app, deployed to a stage. */
export type DeploymentIdentity = {
  app: string;
  stage: string;
};

/** A deployment identity with the entry file it deploys. */
export type Deployment = DeploymentIdentity & {
  /** Absolute path of the entry file. */
  entryPoint: string;
};

/** The key of a deployment's state: `<app>:<stage>`. */
export function resolveDeploymentId(identity: DeploymentIdentity): string {
  assertNameSafe(identity.app, "app");
  assertNameSafe(identity.stage, "stage");
  return `${identity.app}:${identity.stage}`;
}

/**
 * Reads a state key back into its app and stage. Returns `undefined` for a
 * key that is not `<app>:<stage>`, such as the entry path that keyed state
 * before stages existed.
 */
export function parseDeploymentId(
  deploymentId: string,
): DeploymentIdentity | undefined {
  const [app, stage, ...rest] = deploymentId.split(":");
  if (rest.length > 0 || !isNameSafe(app) || !isNameSafe(stage)) {
    return undefined;
  }
  return { app, stage };
}

/** Resolves the config's entry to the absolute path of the entry file. */
export function resolveEntryPoint(project: Project): string {
  const entryPoint = fromProjectRoot(project.config.entry);
  if (!fs.existsSync(entryPoint)) {
    throw new Error(
      `Entry file not found: ${entryPoint}, the entry in ${path.basename(configPath())}`,
    );
  }
  return entryPoint;
}

export type ResolveDeploymentOptions = {
  stage?: string;
  /**
   * The execution being resumed, with the deployment saved when it started.
   * The stage comes from the saved deployment.
   */
  execution?: { id: string; deployment: DeploymentIdentity };
};

/**
 * Resolves the identity of the app's deployment to a stage. The stage falls
 * back to the config's `defaultStage`. The entry file does not have to exist,
 * so commands that only read state still work after the file is deleted.
 */
export function resolveDeploymentIdentity(
  project: Project,
  opts: ResolveDeploymentOptions = {},
): DeploymentIdentity {
  const { config } = project;
  if (opts.execution) return resolveExecutionIdentity(project, opts);
  const stage = opts.stage ?? config.defaultStage;
  if (stage === undefined) {
    throw new Error(
      `No stage given. Pass --stage, or set defaultStage in ${path.basename(configPath())}`,
    );
  }
  assertNameSafe(stage, "stage");
  return { app: config.app, stage };
}

// The config can't be read from the execution, because the entry file comes
// from it. So the app is checked against the config, not taken from the
// execution.
function resolveExecutionIdentity(
  project: Project,
  opts: ResolveDeploymentOptions,
): DeploymentIdentity {
  const { id, deployment } = opts.execution!;
  const configFile = path.basename(configPath());
  if (deployment.app !== project.config.app) {
    throw new Error(
      `Execution ${id} is for app ${deployment.app}, but ${configFile} has app ${project.config.app}. Pass --config with the config of app ${deployment.app}`,
    );
  }
  if (opts.stage !== undefined && opts.stage !== deployment.stage) {
    throw new Error(
      `Execution ${id} is for stage ${deployment.stage}, not ${opts.stage}. Leave out --stage, or pass --stage ${deployment.stage}`,
    );
  }
  return { ...deployment };
}

/**
 * Resolves the app's deployment to a stage, as `resolveDeploymentIdentity`
 * does, and adds the path of the entry file.
 */
export function resolveDeployment(
  project: Project,
  opts: ResolveDeploymentOptions = {},
): Deployment {
  const identity = resolveDeploymentIdentity(project, opts);
  return { ...identity, entryPoint: resolveEntryPoint(project) };
}
