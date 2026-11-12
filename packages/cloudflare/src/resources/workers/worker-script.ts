import * as v from "valibot";
import crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { fromProjectRoot } from "@notation/core/paths";
import {
  resource,
  ResourceNotFoundError,
  type RejectChangeContext,
  type ResourceDeletion,
} from "@notation/resource";
import type { fs } from "@notation/std/resources";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  bindingSchema,
  deleteScript,
  getScriptReferences,
  getScriptSettings,
  isNotFound,
  isReferenced,
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
  /**
   * The ids of hosted namespaces that set `protect: false`. A later plan
   * reads the list from state, and lets deploy delete these namespaces.
   */
  UnprotectedDurableObjects?: string[];
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

const WORKER_SCRIPT_TYPE = "cloudflare/workers/WorkerScript";

const workerScript = resource<WorkerScriptSchema>({
  type: WORKER_SCRIPT_TYPE,
  provider: "@notation/cloudflare/resources",
  deleteTakesDependents: true,
});

/**
 * Deletes a Worker that Cloudflare refuses to delete because other Workers
 * refer to it. The delete is forced when every reference comes from a Worker
 * that is a dependent in the deployment's state, as deploy uploads or
 * deletes each of those in the same run. A forced delete breaks the binding
 * of any other Worker for good, so the delete fails and names them.
 * `refusal` is Cloudflare's error for the delete without `force`.
 */
async function deleteReferencedScript(
  key: WorkerScriptSchema["Key"],
  deletion: ResourceDeletion | undefined,
  refusal: unknown,
): Promise<void> {
  const references = await getScriptReferences(key.AccountId, key.ScriptName);
  const dependents = new Set(
    (deletion?.dependents ?? [])
      .filter(
        ({ type, params }) =>
          type === WORKER_SCRIPT_TYPE &&
          (params.AccountId ?? key.AccountId) === key.AccountId,
      )
      .map(({ params }) => params.ScriptName),
  );
  const others = references.workers.filter((name) => !dependents.has(name));
  if (others.length > 0 || references.pagesFunction) {
    const holders = [
      ...others.map((name) => `the Worker "${name}"`),
      ...(references.pagesFunction ? ["a Pages project"] : []),
    ];
    const one = holders.length === 1;
    const listed = one
      ? holders[0]
      : `${holders.slice(0, -1).join(", ")} and ${holders.at(-1)}`;
    throw new Error(
      `Cannot delete the Worker "${key.ScriptName}": ${listed} ${one ? "refers" : "refer"} to it, and this deployment does not manage ${one ? "that reference" : "those references"}. Deleting the Worker would break ${one ? "it" : "them"}. Remove ${one ? "the reference" : "the references"} to "${key.ScriptName}" first.`,
      { cause: refusal },
    );
  }
  // Cloudflare refused for a reason that the references don't show.
  if (references.workers.length === 0) throw refusal;
  try {
    await deleteScript(key.AccountId, key.ScriptName, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

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
  UnprotectedDurableObjects: {
    propertyType: "param",
    presence: "optional",
    stateOnly: true,
    value: v.array(v.string()),
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

    delete: async (key, _state, _context, deletion) => {
      try {
        await deleteScript(key.AccountId, key.ScriptName);
      } catch (error) {
        if (isNotFound(error)) return;
        if (!isReferenced(error)) throw error;
        await deleteReferencedScript(key, deletion, error);
      }
    },

    rejectChange: rejectNamespaceLoss,
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

const describeHosted = (namespace: HostedNamespace) =>
  `"${namespace.id}" (class ${namespace.className})`;

/**
 * Returns an error message when a change would delete a namespace that the
 * Worker hosted, with its objects, and the namespace was protected when the
 * Worker was last deployed. Cloudflare keys a namespace by its Worker and
 * class name, so the namespace is deleted when the Worker stops hosting it,
 * is replaced or is deleted. Protection is read from state only, so
 * `protect: false` must be deployed before the change that deletes the
 * namespace. Also returns a message when a namespace would get the objects
 * of another namespace.
 */
export function rejectNamespaceLoss(
  previous: Partial<WorkerScriptParams>,
  desired: WorkerScriptParams | undefined,
  context: RejectChangeContext,
): string | undefined {
  const before = previous.DurableObjectNamespaces ?? [];
  const unprotected = previous.UnprotectedDurableObjects ?? [];
  const kept = desired && !context.replace ? desired : undefined;
  const hosted = kept?.DurableObjectNamespaces ?? [];
  // At plan, the list is UNKNOWN_AFTER_APPLY when a dependency has no
  // output yet. Deploy runs the check again with the real params.
  if (!Array.isArray(hosted)) return undefined;

  const lost = before.filter(
    (namespace) =>
      !unprotected.includes(namespace.id) &&
      !hosted.some((now) => now.id === namespace.id),
  );
  if (lost.length > 0) {
    const declarations = lost
      .map((namespace) => `$durableObject({ id: "${namespace.id}" })`)
      .join(", ");
    return `Deploy would delete the Durable Object namespaces ${lost.map(describeHosted).join(", ")} of the Worker ${previous.ScriptName}, with all their objects, which can't be undone. Deploy deletes a namespace when its Worker no longer hosts it, and deletes all of a Worker's namespaces when the Worker is removed or replaced, as when its id or name changes. To keep a namespace, keep its id and export its class from this Worker. A change of class alone keeps the namespace's objects. A namespace can't move to another Worker, so if its class moved, export it from this Worker again. To delete the namespaces, first deploy with \`protect: false\` on ${declarations}, while this Worker still hosts them. Then remove them, or the Worker, in a later deploy.`;
  }

  for (const namespace of hosted) {
    const taken = before.find(
      (other) =>
        other.className === namespace.className && other.id !== namespace.id,
    );
    if (taken) {
      return `The Durable Object namespace "${namespace.id}" has the class ${taken.className}, which the namespace "${taken.id}" had before. Cloudflare keys a namespace by its class name, so "${namespace.id}" would get the objects of "${taken.id}". Give "${namespace.id}" another class, or deploy the change to "${taken.id}" first, and give its old class to "${namespace.id}" in a later deploy.`;
    }
  }
  return undefined;
}

/**
 * Makes the Durable Object `exports` map of the upload. Cloudflare fails an
 * upload that omits a previous namespace, so each one is listed as renamed
 * (same id, new class) or deleted (no longer hosted).
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
