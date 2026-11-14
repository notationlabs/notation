import * as v from "valibot";
import { PROMPT_SOURCE } from "@notation/core";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { getValue } from "@notation/std/sources";
import {
  deleteScriptSecret,
  hasScriptSecret,
  putScriptSecret,
} from "src/api/workers";
import { secretValueFromSchema, type SecretValueFrom } from "src/secrets/value";
import type { WorkerScriptPlaceholderInstance } from "./worker-script-placeholder";

type WorkerSecretParams = {
  AccountId: string;
  ScriptName: string;
  /** The binding's name in `env`. */
  Name: string;
  ValueFrom: SecretValueFrom;
};

export type WorkerSecretSchema = {
  Key: { AccountId: string; ScriptName: string; Name: string };
  CreateParams: WorkerSecretParams;
  UpdateParams: Pick<WorkerSecretParams, "ValueFrom">;
  ReadResult: {};
};

export type WorkerSecretDependencies = {
  placeholder: WorkerScriptPlaceholderInstance;
};

const workerSecret = resource<WorkerSecretSchema>({
  type: "cloudflare/workers/WorkerSecret",
  provider: "@notation/cloudflare/resources",
});

const workerSecretSchema = workerSecret.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  ScriptName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  Name: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.pipe(v.string(), v.nonEmpty()),
  },
  ValueFrom: {
    propertyType: "param",
    presence: "required",
    value: secretValueFromSchema,
  },
} as const);

/**
 * Writes the secret's value, fetched with `getValue`. A secret whose value
 * comes from the prompt is written only when the Worker doesn't have it, so
 * that a value set with `notation secret set` is kept.
 */
async function writeValue(params: WorkerSecretParams): Promise<void> {
  const { AccountId, ScriptName, Name, ValueFrom } = params;
  if (
    ValueFrom.Source === PROMPT_SOURCE &&
    (await hasScriptSecret(AccountId, ScriptName, Name))
  ) {
    return;
  }
  const value = (await getValue(ValueFrom.Secret)).unwrap();
  await putScriptSecret(AccountId, ScriptName, Name, value);
  await waitUntilSecretReadable(AccountId, ScriptName, Name);
}

const READABLE_WITHIN_MS = 15_000;
const READABLE_RETRY_MS = 250;

// Cloudflare sometimes reports a secret as not found for a moment after the
// write that set it. The reconciler reads the secret straight after the
// write, and fails on not found, so the write waits until it can read it.
async function waitUntilSecretReadable(
  account: string,
  scriptName: string,
  name: string,
) {
  const deadline = Date.now() + READABLE_WITHIN_MS;
  while (!(await hasScriptSecret(account, scriptName, name))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Cloudflare accepted the secret ${name} of the Worker ${scriptName}, but still reported it as not found ${READABLE_WITHIN_MS / 1_000} seconds later`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READABLE_RETRY_MS));
  }
}

/**
 * A `secret_text` binding of a Worker, set with Cloudflare's secrets API
 * for the Worker. Its record holds where the value comes from, and never
 * the value. An upload of the Worker keeps its secrets, so it never needs
 * their values.
 *
 * It depends on the Worker's `WorkerScriptPlaceholder`, and the Worker's
 * script depends on it, so the secret is set before the code that reads
 * it is uploaded. Create and update write the value. Each write deploys a
 * new version of the Worker. A change to `ValueFrom`, such as a new version from the
 * source, updates the secret. A secret deleted from the Worker outside
 * notation shows as drift, which the next deploy creates again.
 */
export const WorkerSecret = workerSecretSchema
  .defineOperations({
    // A write replaces the secret, so a failed create is safe to retry.
    create: async (params) => {
      await writeValue(params);
    },

    read: async (key) => {
      if (!(await hasScriptSecret(key.AccountId, key.ScriptName, key.Name))) {
        throw new ResourceNotFoundError("The Worker has no secret by the name");
      }
      return key;
    },

    update: async (_key, patch, params) => {
      if (patch.ValueFrom) await writeValue(params);
    },

    // The script is deleted first, and Cloudflare deletes its secrets with
    // it, so a missing Worker or secret counts as deleted.
    delete: async (key) => {
      await deleteScriptSecret(key.AccountId, key.ScriptName, key.Name);
    },
  })
  .requireDependencies<WorkerSecretDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.placeholder.output.AccountId,
    ScriptName: deps.placeholder.output.ScriptName,
  }));

export type WorkerSecretInstance = InstanceType<typeof WorkerSecret>;
