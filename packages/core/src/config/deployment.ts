import fs from "node:fs";
import { fromProjectRoot } from "src/utils/paths";
import { configFileName } from "./config";
import { assertNameSafe } from "./name-safe";
import type { Project } from "./project";

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

function assertEntryName(project: Project, entry: string) {
  const { entries } = project.config;
  if (!Object.hasOwn(entries, entry)) {
    const names = Object.keys(entries).join(", ");
    throw new Error(
      `No entry named ${JSON.stringify(entry)} in ${configFileName}. Entries: ${names}`,
    );
  }
}

/** Resolves an entry name to the absolute path of its entry file. */
export function resolveEntryPoint(project: Project, entry: string): string {
  assertEntryName(project, entry);
  const entryPoint = fromProjectRoot(project.config.entries[entry]!);
  if (!fs.existsSync(entryPoint)) {
    throw new Error(
      `Entry file not found: ${entryPoint}, the file of entry ${JSON.stringify(entry)} in ${configFileName}`,
    );
  }
  return entryPoint;
}

export type ResolveDeploymentOptions = {
  entry: string;
  stage?: string;
  /** The app the caller expects. Fails when the config names another. */
  app?: string;
};

/**
 * Resolves the identity of an entry's deployment to a stage. The stage falls
 * back to the config's `defaultStage`. The entry must be named in the config,
 * but its file does not have to exist, so commands that only read state still
 * work after the file is deleted.
 */
export function resolveDeploymentIdentity(
  project: Project,
  opts: ResolveDeploymentOptions,
): DeploymentIdentity {
  const { config } = project;
  if (opts.app !== undefined && opts.app !== config.app) {
    throw new Error(
      `${configFileName} names app ${JSON.stringify(config.app)}, not the expected app ${JSON.stringify(opts.app)}`,
    );
  }
  assertEntryName(project, opts.entry);
  const stage = opts.stage ?? config.defaultStage;
  if (stage === undefined) {
    throw new Error(
      `No stage given. Pass --stage, or set defaultStage in ${configFileName}`,
    );
  }
  assertNameSafe(stage, "stage");
  return { app: config.app, stage, entry: opts.entry };
}

/**
 * Resolves the deployment of an entry to a stage, as
 * `resolveDeploymentIdentity` does, and adds the path of the entry file.
 */
export function resolveDeployment(
  project: Project,
  opts: ResolveDeploymentOptions,
): Deployment {
  const identity = resolveDeploymentIdentity(project, opts);
  return { ...identity, entryPoint: resolveEntryPoint(project, opts.entry) };
}
