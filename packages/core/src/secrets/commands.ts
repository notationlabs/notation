import { randomUUID } from "node:crypto";
import {
  containsUnknownAfterApply,
  type BaseResource,
} from "@notation/resource";
import type { Deployment } from "src/config/deployment";
import { getResourceGraph } from "src/orchestrator/graph";
import {
  withRuntime,
  type NodeDurableRuntime,
} from "src/provisioner/durable-runtime";
import {
  runWithSecretContext,
  secretContext,
  type DeclaredSecret,
} from "./context";
import { Redacted } from "./redacted";

export type SecretCommandOptions = {
  deployment: Deployment;
  /** The id of the secret's declaration. */
  id: string;
  runtime?: NodeDurableRuntime;
  databasePath?: string;
};

export type SetSecretOptions = SecretCommandOptions & {
  /** Reads the value. Called once the secret and its location are known. */
  readValue: () => Promise<string>;
};

/**
 * Writes a secret's value to its store, with the secret's create or update.
 * It doesn't run the reconciler, and records nothing.
 */
export async function setSecret(options: SetSecretOptions): Promise<void> {
  await runWithSecretContext(
    { stage: options.deployment.stage, runId: randomUUID() },
    () =>
      withSecretTarget(options, "set", async ({ resource, params, record }) => {
        secretContext()!.supplied = {
          id: options.id,
          value: new Redacted(await options.readValue()),
        };
        if (record && resource.update) {
          await resource.update(
            resource.keyOf(params),
            params,
            params,
            record.output,
          );
        } else {
          await resource.create(params);
        }
      }),
  );
}

export type DeleteSecretOptions = SecretCommandOptions & {
  /** Asks whether to delete. Called once the secret and its location are known. */
  confirm: () => Promise<boolean>;
};

/**
 * Deletes a secret from its store, with the secret's delete. It succeeds if
 * the secret is already gone. Returns false if `confirm` returned false.
 */
export async function deleteSecret(
  options: DeleteSecretOptions,
): Promise<boolean> {
  return runWithSecretContext(
    { stage: options.deployment.stage, runId: randomUUID() },
    () =>
      withSecretTarget(
        options,
        "delete",
        async ({ resource, params, record }) => {
          if (!(await options.confirm())) return false;
          await resource.delete(resource.keyOf(params), {
            ...record?.output,
            ...params,
          });
          return true;
        },
      ),
  );
}

type SecretTarget = {
  resource: BaseResource;
  params: Record<string, unknown>;
  record: { output: Record<string, unknown> } | undefined;
};

/**
 * Evaluates the infra, finds the declared secret, and resolves its location
 * from its params and from state. Must run in a secret context.
 */
async function withSecretTarget<T>(
  options: SecretCommandOptions,
  command: "set" | "delete",
  fn: (target: SecretTarget) => Promise<T>,
): Promise<T> {
  const { deployment, id } = options;
  await getResourceGraph(deployment.entryPoint, {
    app: deployment.app,
    stage: deployment.stage,
  });
  const secret = findDeclaredSecret(id);
  const refusal = command === "set" ? secret.refuseSet : secret.refuseDelete;
  if (refusal) throw new Error(refusal);

  return withRuntime(
    {
      deployment,
      runtime: options.runtime,
      databasePath: options.databasePath,
    },
    async (runtime) => {
      const { resource } = secret;
      const dependencies = resource.getDependencies();
      for (const dependency of dependencies) {
        const node = await runtime.state.get(dependency.id);
        if (node) dependency.setOutput(node.output);
      }
      const params = await resource.planParams();
      const unknownKey = Object.entries(resource.schema).some(
        ([name, item]) =>
          item.propertyType === "param" &&
          (item.primaryKey || item.secondaryKey) &&
          (params[name] === undefined ||
            containsUnknownAfterApply(params[name])),
      );
      if (unknownKey) {
        const missing = dependencies.find((dependency) => !dependency.output);
        throw new Error(
          missing
            ? `\`${id}\`'s location depends on \`${missing.id}\`, which hasn't been deployed. Run \`notation deploy\`.`
            : `\`${id}\`'s location isn't known. Run \`notation deploy\`.`,
        );
      }
      const record = await runtime.state.get(resource.id);
      return fn({ resource, params, record });
    },
  );
}

function findDeclaredSecret(id: string): DeclaredSecret {
  const declared = secretContext()!.declared;
  const secret = declared.get(id);
  if (secret) return secret;
  const ids = [...declared.keys()].sort();
  throw new Error(
    ids.length === 0
      ? `No secret has the id "${id}". The app declares no secrets.`
      : `No secret has the id "${id}". The declared secrets are: ${ids.join(", ")}.`,
  );
}
