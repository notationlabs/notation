import { randomUUID } from "node:crypto";
import { recordSecretValue } from "@notation/utils";
import type { Deployment } from "src/config/deployment";
import { getResourceGraph } from "src/orchestrator/graph";
import {
  runWithSecretContext,
  secretContext,
  type DeclaredSecret,
} from "./context";

export type SecretCommandOptions = {
  deployment: Deployment;
  /** The id of the secret's declaration. */
  id: string;
};

export type SetSecretOptions = SecretCommandOptions & {
  /** Reads the value. Called once the secret is found. */
  readValue: () => Promise<string>;
};

/**
 * Writes a secret's value to its store, with the `set` of its declaration.
 * It doesn't read state or run the reconciler, so it works before the first
 * deploy.
 */
export async function setSecret(options: SetSecretOptions): Promise<void> {
  const secret = await findDeclaredSecret(options);
  if (!secret.set) throw new Error(refusal(secret, "set"));
  const value = await options.readValue();
  recordSecretValue(value);
  await secret.set(value);
}

export type DeleteSecretOptions = SecretCommandOptions & {
  /** Asks whether to delete. Called once the secret is found. */
  confirm: () => Promise<boolean>;
};

/**
 * Deletes a secret from its store, with the `delete` of its declaration. It
 * succeeds if the secret is already gone. Returns false if `confirm`
 * returned false.
 */
export async function deleteSecret(
  options: DeleteSecretOptions,
): Promise<boolean> {
  const secret = await findDeclaredSecret(options);
  if (!secret.delete) throw new Error(refusal(secret, "delete"));
  if (!(await options.confirm())) return false;
  await secret.delete();
  return true;
}

const refusal = (secret: DeclaredSecret, command: string) =>
  secret.refusal ??
  `\`notation secret ${command}\` can't ${command} \`${secret.id}\`.`;

async function findDeclaredSecret({
  deployment,
  id,
}: SecretCommandOptions): Promise<DeclaredSecret> {
  const declared = await runWithSecretContext(
    { stage: deployment.stage, runId: randomUUID() },
    async () => {
      await getResourceGraph(deployment.entryPoint, {
        app: deployment.app,
        stage: deployment.stage,
      });
      return secretContext()!.declared;
    },
  );
  const secret = declared.get(id);
  if (secret) return secret;
  const ids = [...declared.keys()].sort();
  throw new Error(
    ids.length === 0
      ? `No secret has the id "${id}". The app declares no secrets.`
      : `No secret has the id "${id}". The declared secrets are: ${ids.join(", ")}.`,
  );
}
