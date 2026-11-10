import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import {
  cloudflare,
  cloudflareCreate,
  isNotFound,
  scriptPath,
} from "src/resources/api";
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

const setEnabled = (account: string, scriptName: string, enabled: boolean) =>
  cloudflare("POST", `${scriptPath(account, scriptName)}/subdomain`, {
    enabled,
    previews_enabled: false,
  });

/**
 * Serves a Worker on its workers.dev URL,
 * `https://<script>.<account subdomain>.workers.dev`. The account must have
 * a workers.dev subdomain, which the dashboard sets up the first time it
 * opens Workers & Pages.
 */
export const WorkerSubdomain = workerSubdomainSchema
  .defineOperations({
    create: cloudflareCreate(async (params) => {
      await setEnabled(params.AccountId, params.ScriptName, true);
    }),

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
