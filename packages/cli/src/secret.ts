import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  getResourceGraph,
  getSecretTarget,
  listSecretTargets,
  recordSecret,
  resolveDatabasePath,
  runWithExecutionContext,
  runWithSecretValues,
  scrubError,
  withRuntime,
  type Deployment,
  type SecretTarget,
} from "@notation/core";
import {
  SchemaStructureError,
  assertRequiredOutputs,
} from "@notation/resource";
import { sources } from "@notation/std/resources";
import { compile } from "./compile";
import { createScrubbedLogger, defaultLogger, type Logger } from "./logger";
import {
  isTtyPromptAvailable,
  promptConfirm,
  promptSecretHidden,
  readSecretFromStdin,
  type SecretPromptIo,
} from "./secret-prompt";

export type SecretCommandOptions = {
  compile?: boolean;
  logger?: Logger;
  io?: SecretPromptIo;
  databasePath?: string;
};

export type SecretDeleteOptions = SecretCommandOptions & {
  yes?: boolean;
};

type ResolvedSecret = {
  target: SecretTarget;
  params: Record<string, unknown>;
  resourceOutput: Record<string, unknown> | undefined;
};

async function resolveSecretTargetAndParams(
  deployment: Deployment,
  id: string,
  opts: SecretCommandOptions,
  logger: Logger,
): Promise<ResolvedSecret> {
  if (opts.compile !== false) {
    await compile(deployment, { logger });
  }

  await getResourceGraph(deployment.entryPoint, {
    app: deployment.app,
    stage: deployment.stage,
  });

  const target = getSecretTarget(id);
  if (!target) {
    const declared = listSecretTargets().map((t) => t.id);
    if (declared.length > 0) {
      throw new Error(
        `Unknown secret "${id}". Declared secrets: ${declared.join(", ")}.`,
      );
    }
    throw new Error(`Unknown secret "${id}". No secrets are declared.`);
  }

  if (target.isToken) {
    throw new Error(
      `Secret "${id}" is a token's secret; only the token's create can write or manage its value.`,
    );
  }

  const deps = target.resource.getDependencies();
  const locationDeps = deps.filter(
    (dep) => dep.type !== sources.SourceValue.type,
  );
  const valueDeps = deps.filter((dep) => dep.type === sources.SourceValue.type);

  const dbPath = resolveDatabasePath(opts.databasePath);
  if (
    locationDeps.length > 0 &&
    dbPath !== ":memory:" &&
    !fs.existsSync(dbPath)
  ) {
    throw new Error(
      `${id}'s location depends on ${locationDeps[0]!.id}, which hasn't been deployed. Run notation deploy.`,
    );
  }

  return withRuntime(
    { deployment, databasePath: opts.databasePath },
    async (runtime) => {
      // Read existing stores via values() so missing resources do not create
      // empty (version 0, state null) store rows in workflows.db.
      const existingNodes = new Map(
        (await runtime.state.values()).map((node) => [node.id, node]),
      );

      for (const dep of locationDeps) {
        const stateNode = existingNodes.get(dep.id);
        let hasOutputs = Boolean(stateNode);
        if (stateNode) {
          try {
            assertRequiredOutputs(dep, stateNode.output);
          } catch (error) {
            if (!SchemaStructureError.is(error)) throw error;
            hasOutputs = false;
          }
        }
        if (!hasOutputs) {
          throw new Error(
            `${id}'s location depends on ${dep.id}, which hasn't been deployed. Run notation deploy.`,
          );
        }
        dep.setOutput(stateNode!.output);
      }

      for (const dep of valueDeps) {
        const stateNode = existingNodes.get(dep.id);
        if (stateNode) {
          dep.setOutput(stateNode.output);
        } else {
          // A sourced secret can be set before its first deploy; supply
          // placeholder SourceValue outputs so deriveParams can resolve the
          // secret's location without requiring SourceValue in state.
          dep.setOutput({
            Source: target.source?.name ?? dep.config?.Source ?? "source",
            Key: target.key ?? dep.config?.Key ?? "",
            Version: "",
          });
        }
      }

      const resourceState = existingNodes.get(target.resource.id);
      const params = await runWithExecutionContext(
        { stage: deployment.stage, executionId: randomUUID() },
        () => target.resource.getParams(),
      );

      for (const [field, item] of Object.entries(target.resource.schema)) {
        if (
          item.propertyType === "param" &&
          item.presence === "required" &&
          params[field] === undefined
        ) {
          const depId = locationDeps[0]?.id ?? "its location";
          throw new Error(
            `${id}'s location depends on ${depId}, which hasn't been deployed. Run notation deploy.`,
          );
        }
      }

      return {
        target,
        params,
        resourceOutput: resourceState?.output,
      };
    },
  );
}

export async function secretSet(
  deployment: Deployment,
  id: string,
  opts: SecretCommandOptions = {},
): Promise<void> {
  const logger = createScrubbedLogger(opts.logger ?? defaultLogger);
  const { target, params } = await resolveSecretTargetAndParams(
    deployment,
    id,
    opts,
    logger,
  );

  const value = isTtyPromptAvailable(opts.io)
    ? (
        await promptSecretHidden({
          id,
          stage: deployment.stage,
          ...opts.io,
        })
      ).unwrap()
    : await readSecretFromStdin(opts.io?.stdin);

  recordSecret(value);

  await runWithExecutionContext(
    { stage: deployment.stage, executionId: randomUUID() },
    () =>
      runWithSecretValues({ [id]: value }, async () => {
        try {
          await target.resource.create(params);
        } catch (error) {
          throw scrubError(error);
        }
      }),
  );

  logger.info(`Set secret ${id} for stage ${deployment.stage}.`);
}

export async function secretDelete(
  deployment: Deployment,
  id: string,
  opts: SecretDeleteOptions = {},
): Promise<void> {
  const logger = createScrubbedLogger(opts.logger ?? defaultLogger);
  const { target, params, resourceOutput } = await resolveSecretTargetAndParams(
    deployment,
    id,
    opts,
    logger,
  );

  if (!opts.yes) {
    if (!isTtyPromptAvailable(opts.io)) {
      throw new Error(`Pass --yes to delete secret "${id}" without a TTY.`);
    }
    const confirmed = await promptConfirm({
      message: `Delete secret "${id}" for stage ${deployment.stage}? [y/N] `,
      ...opts.io,
    });
    if (!confirmed) {
      logger.info("Aborted.");
      return;
    }
  }

  await runWithExecutionContext(
    { stage: deployment.stage, executionId: randomUUID() },
    async () => {
      const key = target.resource.keyOf(params);
      try {
        await target.resource.delete(key, resourceOutput);
      } catch (error) {
        throw scrubError(error);
      }
    },
  );

  if (params.Adopted) {
    logger.info(`Secret ${id} is adopted (explicit name); left in the store.`);
  } else {
    logger.info(`Deleted secret ${id} for stage ${deployment.stage}.`);
  }
}
