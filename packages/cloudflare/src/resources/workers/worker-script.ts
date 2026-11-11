import * as v from "valibot";
import crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { fromProjectRoot } from "@notation/core/paths";
import { resource, ResourceNotFoundError } from "@notation/resource";
import type { fs } from "@notation/std/resources";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  bindingSchema,
  deleteScript,
  getScriptSettings,
  isNotFound,
  putScript,
  type DurableObjectExport,
  type ScriptBinding,
} from "src/api/workers";

export type { DurableObjectExport };

export type WorkerBinding = ScriptBinding;

const hostedNamespaceSchema = v.object({
  /** The `$durableObject` id. Stable when the class is renamed. */
  id: v.string(),
  className: v.string(),
});

/** A Durable Object namespace that the Worker hosts. */
export type HostedNamespace = v.InferOutput<typeof hostedNamespaceSchema>;

type WorkerScriptParams = {
  AccountId: string;
  ScriptName: string;
  /** The uploaded file name of the main module. */
  MainModule: string;
  /** The bundle to upload, relative to the project root. */
  CodeFilePath: string;
  /** A base64 SHA-256 of the bundle. */
  CodeSha256: string;
  CompatibilityDate: string;
  CompatibilityFlags?: string[];
  Bindings?: WorkerBinding[];
  DurableObjectNamespaces?: HostedNamespace[];
};

export type WorkerScriptSchema = {
  Key: { AccountId: string; ScriptName: string };
  CreateParams: WorkerScriptParams;
  UpdateParams: Omit<WorkerScriptParams, "AccountId" | "ScriptName">;
  ReadResult: {};
};

export type WorkerScriptDependencies = {
  code: fs.FileInstance;
};

const workerScript = resource<WorkerScriptSchema>({
  type: "cloudflare/workers/WorkerScript",
  provider: "@notation/cloudflare/resources",
});

const workerScriptSchema = workerScript.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    rejectReplace: (previous, desired) =>
      `CLOUDFLARE_ACCOUNT_ID is ${desired}, but this Worker was deployed to the account ${previous}. A Worker can't move to another account, and replacing it would delete the objects of the Durable Object namespaces that it hosts. Set CLOUDFLARE_ACCOUNT_ID back to ${previous}. To deploy to the other account, first run \`notation destroy\` with the old account, or deploy to another stage.`,
    value: v.string(),
  },
  ScriptName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.string(),
  },
  MainModule: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  CodeFilePath: {
    propertyType: "param",
    presence: "required",
    hidden: true,
    value: v.string(),
  },
  CodeSha256: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  CompatibilityDate: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)),
  },
  CompatibilityFlags: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.string()),
  },
  Bindings: {
    propertyType: "param",
    presence: "optional",
    value: v.array(bindingSchema),
    collect: (items: unknown[]) => items.flat() as WorkerBinding[],
  },
  DurableObjectNamespaces: {
    propertyType: "param",
    presence: "optional",
    value: v.array(hostedNamespaceSchema),
  },
} as const);

export const WorkerScript = workerScriptSchema
  .defineOperations({
    // An upload replaces a Worker with the same name, so check first. The
    // check is outside `cloudflareCreate`: if it throws, nothing was created.
    create: async (params) => {
      if (await getScriptSettings(params.AccountId, params.ScriptName)) {
        throw new Error(
          `A Worker named ${params.ScriptName} already exists in the Cloudflare account ${params.AccountId}`,
        );
      }
      await cloudflareCreate(upload)(params, []);
    },

    read: async (key) => {
      const settings = await getScriptSettings(key.AccountId, key.ScriptName);
      if (!settings) {
        throw new ResourceNotFoundError("Worker was not found");
      }
      return {
        AccountId: key.AccountId,
        ScriptName: key.ScriptName,
        CompatibilityDate: settings.compatibility_date,
        CompatibilityFlags: settings.compatibility_flags
          ? sortedFlags(settings.compatibility_flags)
          : undefined,
      };
    },

    // An upload sets the whole Worker, so the patch is not used. The upload
    // compares the namespaces in state with the new ones, to rename or
    // delete those that changed.
    update: async (_key, _patch, params, state) => {
      await upload(params, state.DurableObjectNamespaces ?? []);
    },

    delete: async (key) => {
      try {
        await deleteScript(key.AccountId, key.ScriptName);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  })
  .requireDependencies<WorkerScriptDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: accountId(),
    MainModule: path.basename(deps.code.output.filePath),
    CodeFilePath: deps.code.output.filePath,
    CodeSha256: deps.code.output.fileSha256,
  }));

export type WorkerScriptInstance = InstanceType<typeof WorkerScript>;

/**
 * Sorts the flags, so that the order that Cloudflare returns them in is not
 * seen as a change.
 */
export function sortedFlags(flags: string[]): string[] {
  return [...new Set(flags)].sort();
}

async function upload(
  params: WorkerScriptParams,
  previous: HostedNamespace[],
): Promise<void> {
  const code = await readCode(params.CodeFilePath, params.CodeSha256);
  const exports = durableObjectExports(
    params.DurableObjectNamespaces ?? [],
    previous,
  );
  await putScript(params.AccountId, params.ScriptName, {
    mainModule: params.MainModule,
    code,
    compatibilityDate: params.CompatibilityDate,
    compatibilityFlags: params.CompatibilityFlags ?? [],
    bindings: params.Bindings ?? [],
    exports,
  });
}

/**
 * Makes the Durable Object `exports` map of the upload. Cloudflare fails an
 * upload that omits a previous namespace, so each one is listed as renamed
 * (same id, new class) or deleted (no longer declared).
 *
 * Throws if a namespace has the class name that another namespace had in
 * the previous upload. Cloudflare identifies a namespace by its class name,
 * so the namespace would get the other namespace's objects.
 */
export function durableObjectExports(
  hosted: HostedNamespace[],
  previous: HostedNamespace[],
): Record<string, DurableObjectExport> {
  const exports: Record<string, DurableObjectExport> = {};
  const live = new Set(hosted.map((namespace) => namespace.className));
  for (const namespace of hosted) {
    exports[namespace.className] = {
      type: "durable-object",
      storage: "sqlite",
    };
  }
  for (const before of previous) {
    const taker = hosted.find(
      (namespace) => namespace.className === before.className,
    );
    if (taker && taker.id !== before.id) {
      throw new Error(
        `The Durable Object namespace "${taker.id}" has the class ${before.className}, which the namespace "${before.id}" had before. Cloudflare keys a namespace by its class name, so "${taker.id}" would get the objects of "${before.id}". Deploy the change to "${before.id}" first, then give the class to "${taker.id}" in a later deploy, or give "${taker.id}" another class.`,
      );
    }
    if (live.has(before.className)) continue;
    const now = hosted.find((namespace) => namespace.id === before.id);
    exports[before.className] = now
      ? { type: "durable-object", state: "renamed", renamed_to: now.className }
      : { type: "durable-object", state: "deleted" };
  }
  return exports;
}

/**
 * Reads the Worker's bundle and throws if its hash is not `expectedSha256`.
 * A resumed deploy reuses the params of the first attempt, and the file may
 * have changed since.
 */
async function readCode(filePath: string, expectedSha256: string) {
  const code = await nodeFs.readFile(fromProjectRoot(filePath));
  const actualSha256 = crypto
    .createHash("sha256")
    .update(code)
    .digest("base64");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `The Worker bundle at ${filePath} has SHA-256 ${actualSha256}, but this deploy expects ${expectedSha256}. The file changed after the deploy computed its params; start a new deploy.`,
    );
  }
  return code;
}
