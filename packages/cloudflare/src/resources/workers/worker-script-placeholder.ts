import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { accountId, cloudflareCreate } from "src/api/client";
import { workerNameRule } from "src/id";
import {
  deleteScript,
  getScriptSettings,
  isNotFound,
  isPlaceholderScript,
  PLACEHOLDER_TAG,
  putScript,
} from "src/api/workers";
import { waitUntilReadable } from "./worker-script";

// Cloudflare rejects a module without a handler (error 10068).
const PLACEHOLDER_CODE = `export default {
  fetch: () => new Response("This Worker is being deployed.", { status: 503 }),
};
`;
const PLACEHOLDER_MODULE = "placeholder.mjs";
const PLACEHOLDER_COMPATIBILITY_DATE = "2025-01-01";

type WorkerScriptPlaceholderParams = {
  AccountId: string;
  ScriptName: string;
  /** The name of the Worker's script in its state record, if it has one. */
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
    rejectReplace: (previous, desired) =>
      `CLOUDFLARE_ACCOUNT_ID is ${desired}, but this Worker was deployed to the account ${previous}. A Worker can't move to another account. Set CLOUDFLARE_ACCOUNT_ID back to ${previous}. To deploy to the other account, first run \`notation destroy\` with the old account, or deploy to another stage.`,
    value: v.string(),
  },
  // The name that the Worker's script takes. A contribution supplies the
  // script's recorded name, so a live Worker keeps its name. A replace that
  // creates first would collide with the supplied name, but only an
  // AccountId change replaces the placeholder, and rejectReplace refuses it.
  ScriptName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.string(),
    physicalName: {
      ...workerNameRule,
      // The base of `worker:<id>:placeholder` is `<id>`, as for the script.
      base: (resourceId: string) =>
        resourceId.replace(/^worker:/, "").replace(/:placeholder$/, ""),
      suppliable: true,
    },
    collect: (items: unknown[]) => items[0] as string,
  },
  // Hidden, so that the script's first record doesn't show as a change.
  AdoptedScriptName: {
    propertyType: "param",
    presence: "optional",
    hidden: true,
    value: v.string(),
    collect: (items: unknown[]) => items[0] as string,
  },
} as const);

/**
 * Makes sure that a Worker exists by the name its script takes, before its
 * `WorkerSecret`s are set and before its code is uploaded. Secrets can only
 * be set on a Worker that exists, and setting them first means new code
 * never runs without them.
 *
 * Create leaves a Worker alone when it is the live Worker of the script's
 * state record, or when it carries the placeholder tag from an earlier
 * attempt. When no Worker exists, it uploads code that answers 503, tagged
 * `notation-placeholder`. It refuses a Worker that exists without the tag,
 * so that it never overwrites code, or lets secrets be written to a Worker,
 * that the deployment doesn't own. The script's first upload removes the
 * tag.
 *
 * Delete removes the Worker only while it still carries the tag. A Worker
 * without the tag belongs to the script, which deletes it.
 */
export const WorkerScriptPlaceholder = workerScriptPlaceholderSchema
  .defineOperations({
    create: async (params) => {
      const { AccountId, ScriptName } = params;
      const settings = await getScriptSettings(AccountId, ScriptName);
      if (settings) {
        if (params.AdoptedScriptName === ScriptName) return;
        if (isPlaceholderScript(settings)) return;
        // Not ResourceAlreadyExistsError: deploy would take the Worker over.
        throw new Error(
          `A Worker named ${ScriptName} already exists in the Cloudflare account ${AccountId}, and this deployment didn't create it. Deploy won't set secrets on it or upload code over it. Delete it, or give the $worker another id.`,
        );
      }
      await cloudflareCreate(async () => {
        await putScript(AccountId, ScriptName, {
          mainModule: PLACEHOLDER_MODULE,
          code: Buffer.from(PLACEHOLDER_CODE),
          compatibilityDate: PLACEHOLDER_COMPATIBILITY_DATE,
          compatibilityFlags: [],
          bindings: [],
          exports: {},
          containers: [],
          tags: [PLACEHOLDER_TAG],
        });
        await waitUntilReadable(AccountId, ScriptName);
      })();
    },

    read: async (key) => {
      if (!(await getScriptSettings(key.AccountId, key.ScriptName))) {
        throw new ResourceNotFoundError("Worker was not found");
      }
      return { AccountId: key.AccountId, ScriptName: key.ScriptName };
    },

    update: async () => {},

    delete: async (key) => {
      const settings = await getScriptSettings(key.AccountId, key.ScriptName);
      if (!settings || !isPlaceholderScript(settings)) return;
      try {
        await deleteScript(key.AccountId, key.ScriptName);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    deriveParams: () => ({ AccountId: accountId() }),
  });

export type WorkerScriptPlaceholderInstance = InstanceType<
  typeof WorkerScriptPlaceholder
>;
