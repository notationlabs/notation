import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { hasScriptSecret } from "src/api/workers";
import { secretValueFromSchema, type SecretValueFrom } from "src/secrets/value";

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
 * @deprecated `$worker` sends its secrets in the upload, with the
 * `Secrets` param of `WorkerScript`. This class stays for one release, so
 * that deploy can delete the records of earlier deployments.
 */
export const WorkerSecret = workerSecretSchema.defineOperations({
  create: async () => {
    throw new Error(
      "WorkerSecret is deprecated and can't create a secret. Bind the secret to a $worker, which sends it in the upload of its code.",
    );
  },

  read: async (key) => {
    if (!(await hasScriptSecret(key.AccountId, key.ScriptName, key.Name))) {
      throw new ResourceNotFoundError("The Worker has no secret by the name");
    }
    return key;
  },

  // Removes only the record. The upload of the Worker has set the same
  // secret through the script's `Secrets`, and deleting the secret would
  // undo that.
  delete: async () => {},
});

export type WorkerSecretInstance = InstanceType<typeof WorkerSecret>;
