import * as v from "valibot";
import { PROMPT_SOURCE } from "@notation/core";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { getValue } from "@notation/std/sources";
import { hasScriptSecret, putScriptSecret } from "src/api/workers";
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
 * the value.
 *
 * @deprecated `$worker` sends its secrets in the upload, with the
 * `Secrets` param of `WorkerScript`. This class stays for one release, so
 * that deploy can delete the records of earlier deployments. Its delete
 * leaves the secret on the Worker.
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

    // Removes only the record. `$worker` no longer declares this class, so
    // deploy deletes the records of earlier deployments, after the upload
    // of the Worker has set the same secret through the script's `Secrets`.
    // Deleting the secret would undo that.
    delete: async () => {},
  })
  .requireDependencies<WorkerSecretDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.placeholder.output.AccountId,
    ScriptName: deps.placeholder.output.ScriptName,
  }));

export type WorkerSecretInstance = InstanceType<typeof WorkerSecret>;
