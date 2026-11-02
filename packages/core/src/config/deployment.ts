import fs from "node:fs";
import path from "node:path";
import { configPath, fromProjectRoot } from "src/utils/paths";
import { assertNameSafe } from "./name-safe";
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
  const stage = opts.stage ?? config.defaultStage;
  if (stage === undefined) {
    throw new Error(
      `No stage given. Pass --stage, or set defaultStage in ${path.basename(configPath())}`,
    );
  }
  assertNameSafe(stage, "stage");
  return { app: config.app, stage };
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
