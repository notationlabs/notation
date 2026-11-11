import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { cloudflare, isNotFound, scriptPath } from "src/resources/api";
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

// `previews_enabled` is omitted, so the preview URL setting from the
// dashboard is kept.
const setEnabled = (account: string, scriptName: string, enabled: boolean) =>
  cloudflare("POST", `${scriptPath(account, scriptName)}/subdomain`, {
    enabled,
  });

/**
 * Serves a Worker at `https://<script>.<account subdomain>.workers.dev`. The
 * account needs a workers.dev subdomain.
 */
export const WorkerSubdomain = workerSubdomainSchema
  .defineOperations({
    // Enabling is idempotent, so a failed create is safe to retry.
    create: async (params) => {
      await setEnabled(params.AccountId, params.ScriptName, true);
    },

    read: async (key) => {
      let enabled: boolean | undefined;
      try {
        ({ enabled } = await cloudflare<{ enabled: boolean }>(
          "GET",
          `${scriptPath(key.AccountId, key.ScriptName)}/subdomain`,
        ));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!enabled) {
        throw new ResourceNotFoundError(
          "The Worker is not served on workers.dev",
        );
      }
      const { subdomain } = await cloudflare<{ subdomain: string }>(
        "GET",
        `/accounts/${encodeURIComponent(key.AccountId)}/workers/subdomain`,
      );
      return {
        ...key,
        Url: `https://${key.ScriptName}.${subdomain}.workers.dev`,
      };
    },

    delete: async (key) => {
      try {
        await setEnabled(key.AccountId, key.ScriptName, false);
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
