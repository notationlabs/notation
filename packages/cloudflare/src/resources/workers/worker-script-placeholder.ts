import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import {
  deleteScript,
  getScriptSettings,
  isNotFound,
  isPlaceholderScript,
} from "src/api/workers";

type WorkerScriptPlaceholderParams = {
  AccountId: string;
  ScriptName: string;
  AdoptedScriptName?: string;
};

export type WorkerScriptPlaceholderSchema = {
  Key: { AccountId: string; ScriptName: string };
  CreateParams: WorkerScriptPlaceholderParams;
  UpdateParams: Pick<WorkerScriptPlaceholderParams, "AdoptedScriptName">;
  ReadResult: {};
};

const workerScriptPlaceholder = resource<WorkerScriptPlaceholderSchema>({
  type: "cloudflare/workers/WorkerScriptPlaceholder",
  provider: "@notation/cloudflare/resources",
});

const workerScriptPlaceholderSchema = workerScriptPlaceholder.defineSchema({
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
    primaryKey: true,
    value: v.string(),
  },
  AdoptedScriptName: {
    propertyType: "param",
    presence: "optional",
    hidden: true,
    value: v.string(),
  },
} as const);

/**
 * @deprecated `$worker` sends its secrets in the upload of its code, so it
 * no longer needs a placeholder. This class stays for one release, so that
 * deploy can delete the records of earlier deployments.
 */
export const WorkerScriptPlaceholder =
  workerScriptPlaceholderSchema.defineOperations({
    create: async () => {
      throw new Error(
        "WorkerScriptPlaceholder is deprecated and can't create a Worker. Declare the Worker with $worker.",
      );
    },

    read: async (key) => {
      if (!(await getScriptSettings(key.AccountId, key.ScriptName))) {
        throw new ResourceNotFoundError("Worker was not found");
      }
      return { AccountId: key.AccountId, ScriptName: key.ScriptName };
    },

    // A Worker without the placeholder tag belongs to its `WorkerScript`,
    // which deletes it.
    delete: async (key) => {
      const settings = await getScriptSettings(key.AccountId, key.ScriptName);
      if (!settings || !isPlaceholderScript(settings)) return;
      try {
        await deleteScript(key.AccountId, key.ScriptName);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  });

export type WorkerScriptPlaceholderInstance = InstanceType<
  typeof WorkerScriptPlaceholder
>;
