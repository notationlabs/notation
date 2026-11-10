import * as v from "valibot";
import crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { fromProjectRoot } from "@notation/core/paths";
import { resource, ResourceNotFoundError } from "@notation/resource";
import type { fs } from "@notation/std/resources";
import {
  accountId,
  cloudflare,
  cloudflareCreate,
  isNotFound,
  scriptPath,
} from "src/resources/api";

export type WorkerBinding =
  | { type: "plain_text"; name: string; text: string }
  | {
      type: "durable_object_namespace";
      name: string;
      class_name: string;
      /** The Worker that hosts the namespace, when it is another Worker. */
      script_name?: string;
    }
  | { type: "service"; name: string; service: string };

/**
 * A Durable Object namespace that the Worker hosts. `id` is the ID of the
 * namespace's declaration, which stays the same when its class is renamed.
 */
export type HostedNamespace = { id: string; className: string };

type WorkerScriptParams = {
  AccountId: string;
  ScriptName: string;
  /** The file name of the main module, as uploaded. */
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

const bindingSchema = v.variant("type", [
  v.object({
    type: v.literal("plain_text"),
    name: v.string(),
    text: v.string(),
  }),
  v.object({
    type: v.literal("durable_object_namespace"),
    name: v.string(),
    class_name: v.string(),
    script_name: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("service"),
    name: v.string(),
    service: v.string(),
  }),
]);

const workerScriptSchema = workerScript.defineSchema({
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
  },
  DurableObjectNamespaces: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.object({ id: v.string(), className: v.string() })),
  },
} as const);

type Settings = {
  compatibility_date?: string;
  compatibility_flags?: string[];
};

export const WorkerScript = workerScriptSchema
  .defineOperations({
    // An upload replaces a Worker of the same name, so a Worker that exists
    // already is reported, instead of being taken over.
    create: cloudflareCreate(async (params) => {
      if (await readSettings(params.AccountId, params.ScriptName)) {
        throw new Error(
          `A Worker named ${params.ScriptName} already exists in the Cloudflare account ${params.AccountId}`,
        );
      }
      await upload(params, []);
    }),

    read: async (key) => {
      const settings = await readSettings(key.AccountId, key.ScriptName);
      if (!settings) {
        throw new ResourceNotFoundError("Worker was not found");
      }
      return {
        AccountId: key.AccountId,
        ScriptName: key.ScriptName,
        CompatibilityDate: settings.compatibility_date,
        CompatibilityFlags: settings.compatibility_flags,
      };
    },

    // An upload sets the whole Worker, so each update uploads all the
    // params. The namespaces in state are the ones that the Worker hosted
    // before, which the upload renames or deletes.
    update: async (_key, _patch, params, state) => {
      await upload(params, state.DurableObjectNamespaces ?? []);
    },

    delete: async (key) => {
      try {
        await cloudflare("DELETE", scriptPath(key.AccountId, key.ScriptName));
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

async function readSettings(
  account: string,
  scriptName: string,
): Promise<Settings | undefined> {
  try {
    return await cloudflare<Settings>(
      "GET",
      `${scriptPath(account, scriptName)}/settings`,
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
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
  const metadata = {
    main_module: params.MainModule,
    compatibility_date: params.CompatibilityDate,
    compatibility_flags: params.CompatibilityFlags ?? [],
    bindings: params.Bindings ?? [],
    ...(Object.keys(exports).length > 0 ? { exports } : {}),
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set(
    params.MainModule,
    new File([code], params.MainModule, {
      type: "application/javascript+module",
    }),
  );
  await cloudflare(
    "PUT",
    scriptPath(params.AccountId, params.ScriptName),
    form,
  );
}

export type DurableObjectExport =
  | { type: "durable-object"; storage: "sqlite" }
  | { type: "durable-object"; state: "deleted" }
  | { type: "durable-object"; state: "renamed"; renamed_to: string };

/**
 * Makes the Worker's declarative Durable Object `exports` map. Cloudflare
 * doesn't keep a namespace that the map leaves out, and fails the upload
 * instead, so each namespace that the Worker hosted before is listed too:
 *
 * 1. A namespace that the Worker hosts is live. A new one uses SQLite
 *    storage, as Cloudflare makes every new namespace with it.
 * 2. A namespace whose declaration has the same ID and another class is
 *    renamed, which keeps its objects.
 * 3. A namespace whose declaration is gone is deleted, with its objects.
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
    if (live.has(before.className)) continue;
    const now = hosted.find((namespace) => namespace.id === before.id);
    exports[before.className] = now
      ? { type: "durable-object", state: "renamed", renamed_to: now.className }
      : { type: "durable-object", state: "deleted" };
  }
  return exports;
}

/**
 * Reads the bundle to upload. A resumed deploy reuses the params of the
 * original run, and the file may have changed since then, so the bytes must
 * still match the recorded hash.
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
