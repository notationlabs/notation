import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import {
  getAccountSubdomain,
  getScriptSubdomain,
  isNotFound,
  setScriptSubdomain,
} from "src/api/workers";
import type { WorkerScriptInstance } from "./worker-script";

export type WorkerSubdomainSchema = {
  Key: { AccountId: string; ScriptName: string };
  CreateParams: { AccountId: string; ScriptName: string };
  UpdateParams: {};
  ReadResult: { Url: string };
};

export type WorkerSubdomainDependencies = {
  script: WorkerScriptInstance;
};

const workerSubdomain = resource<WorkerSubdomainSchema>({
  type: "cloudflare/workers/WorkerSubdomain",
  provider: "@notation/cloudflare/resources",
});

const workerSubdomainSchema = workerSubdomain.defineSchema({
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
  Url: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * Serves a Worker at `https://<script>.<account subdomain>.workers.dev`. The
 * account needs a workers.dev subdomain.
 */
export const WorkerSubdomain = workerSubdomainSchema
  .defineOperations({
    // Enabling is idempotent, so a failed create is safe to retry.
    create: async (params) => {
      await setScriptSubdomain(params.AccountId, params.ScriptName, true);
    },
    ownership: "parent",

    read: async (key) => {
      const subdomain = await getScriptSubdomain(key.AccountId, key.ScriptName);
      if (!subdomain?.enabled) {
        throw new ResourceNotFoundError(
          "The Worker is not served on workers.dev",
        );
      }
      const accountSubdomain = await getAccountSubdomain(key.AccountId);
      return {
        ...key,
        Url: `https://${key.ScriptName}.${accountSubdomain}.workers.dev`,
      };
    },

    delete: async (key) => {
      try {
        await setScriptSubdomain(key.AccountId, key.ScriptName, false);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  })
  .requireDependencies<WorkerSubdomainDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.script.output.AccountId,
    ScriptName: deps.script.output.ScriptName,
  }));

export type WorkerSubdomainInstance = InstanceType<typeof WorkerSubdomain>;
