import path from "node:path";
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

/** Resolves an entry name to the absolute path of its entry file. */
export function resolveEntryPoint(project: Project, entry: string): string {
  const { entries } = project.config;
  if (!Object.hasOwn(entries, entry)) {
    const names = Object.keys(entries).join(", ");
    throw new Error(
      `No entry named ${JSON.stringify(entry)} in ${configFileName}. Entries: ${names}`,
    );
  }
  return path.resolve(project.root, entries[entry]!);
}

/**
 * Resolves the deployment of an entry, named in the config, to a stage. The
 * stage falls back to the config's `defaultStage`.
 */
export function resolveDeployment(
  project: Project,
  opts: {
    entry: string;
    stage?: string;
  },
): Deployment {
  const { config } = project;
  const entryPoint = resolveEntryPoint(project, opts.entry);
  const stage = opts.stage ?? config.defaultStage;
  if (stage === undefined) {
    throw new Error(
      `No stage given. Pass --stage, or set defaultStage in ${configFileName}`,
    );
  }
  assertNameSafe(stage, "stage");
  return { app: config.app, stage, entry: opts.entry, entryPoint };
}
