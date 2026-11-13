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
  listAccountNamespaces,
  patchScriptExports,
  putScript,
  type AccountNamespace,
  type DurableObjectExport,
  type ScriptBinding,
  type ScriptUpload,
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

const boundNamespaceSchema = v.object({
  id: v.string(),
  className: v.string(),
  /** The Worker that hosts the namespace. */
  scriptName: v.string(),
});

/** A Durable Object namespace that the Worker binds on another Worker. */
export type BoundNamespace = v.InferOutput<typeof boundNamespaceSchema>;

const transferSourceSchema = v.object({
  /** The id of a namespace that the Worker hosts. */
  id: v.string(),
  /** The other Workers that bind the namespace. */
  scriptNames: v.array(v.string()),
});

export type TransferSource = v.InferOutput<typeof transferSourceSchema>;

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
  /**
   * A namespace that the Worker hosted before and binds on another Worker
   * now has moved to that Worker. Deploy doesn't delete it from this Worker:
   * the new host's deploy moves it, with its objects.
   */
  BoundDurableObjects?: BoundNamespace[];
  /**
   * When a hosted namespace is new to the Worker, and one of the Workers
   * listed for it hosts a namespace with its class, deploy moves that
   * namespace and its objects to this Worker.
   */
  DurableObjectTransferSources?: TransferSource[];
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
    value: v.array(v.string()),
  },
  BoundDurableObjects: {
    propertyType: "param",
    presence: "optional",
    hidden: true,
    value: v.array(boundNamespaceSchema),
  },
  DurableObjectTransferSources: {
    propertyType: "param",
    presence: "optional",
    hidden: true,
    value: v.array(transferSourceSchema),
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
      const found = await findTransfers(params, []);
      if (found.transfers.length > 0) {
        throw new Error(newHostError(params, found.transfers));
      }
      await cloudflareCreate(upload)(params, [], found);
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
    // compares the namespaces in state with the new ones, to rename, delete
    // or move those that changed.
    update: async (_key, _patch, params, state) => {
      const previous = state.DurableObjectNamespaces ?? [];
      await upload(params, previous, await findTransfers(params, previous));
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

/**
 * Uploads the Worker, and first moves the namespaces of `found` to it.
 * `rejectNamespaceLoss` fails a move in the deploy that renames or deletes
 * a namespace of the Worker, so the exports of a move have no such entries.
 */
async function upload(
  params: WorkerScriptParams,
  previous: HostedNamespace[],
  found: FoundTransfers,
): Promise<void> {
  const code = await readCode(params.CodeFilePath, params.CodeSha256);
  const exports = durableObjectExports(
    params.DurableObjectNamespaces ?? [],
    previous,
    params.BoundDurableObjects ?? [],
  );
  const upload: ScriptUpload = {
    mainModule: params.MainModule,
    code,
    compatibilityDate: params.CompatibilityDate,
    compatibilityFlags: params.CompatibilityFlags ?? [],
    bindings: params.Bindings ?? [],
    exports,
  };
  if (found.transfers.length > 0) {
    await transferNamespaces(params, upload, found.transfers, found.account);
  }
  await putScript(params.AccountId, params.ScriptName, upload);
}

type Transfer = {
  id: string;
  className: string;
  /** The Worker that hosts the namespace before the transfer. */
  from: string;
};

type FoundTransfers = { transfers: Transfer[]; account: AccountNamespace[] };

/**
 * Finds the hosted namespaces that are new to the Worker and that another
 * Worker of the deployment hosts now, with the account's namespaces. Lists
 * the account's namespaces only when a new namespace has transfer sources.
 */
async function findTransfers(
  params: WorkerScriptParams,
  previous: HostedNamespace[],
): Promise<FoundTransfers> {
  const sources = params.DurableObjectTransferSources ?? [];
  const arriving = (params.DurableObjectNamespaces ?? []).flatMap(
    (namespace) => {
      if (previous.some((before) => before.id === namespace.id)) return [];
      const from = sources.find((source) => source.id === namespace.id);
      return from && from.scriptNames.length > 0
        ? [{ namespace, scriptNames: from.scriptNames }]
        : [];
    },
  );
  if (arriving.length === 0) return { transfers: [], account: [] };
  const account = await listAccountNamespaces(params.AccountId);
  const transfers: Transfer[] = [];
  for (const { namespace, scriptNames } of arriving) {
    const hosts = account.filter(
      (other) =>
        other.className === namespace.className &&
        scriptNames.includes(other.script),
    );
    if (hosts.length > 1) {
      throw new Error(
        `The Durable Object namespace "${namespace.id}" is new to the Worker ${params.ScriptName}, and the Workers ${hosts.map((host) => host.script).join(" and ")} each host a namespace with its class ${namespace.className}. Deploy can't tell which one to move to ${params.ScriptName}.`,
      );
    }
    // No Worker hosts the class: the namespace is new, or a transfer that
    // stopped part way through has already moved it.
    if (hosts.length === 0) continue;
    const from = hosts[0]!.script;
    const legacy = account.find(
      (other) => other.script === from && !other.sqlite,
    );
    if (legacy) {
      throw new Error(
        `Cannot move the Durable Object namespace "${namespace.id}" from the Worker ${from}: ${from} also hosts the namespace of the class ${legacy.className}, which Cloudflare's namespace list doesn't show as using SQLite storage. Notation can move a namespace only from a Worker whose namespaces all use SQLite.`,
      );
    }
    transfers.push({ id: namespace.id, className: namespace.className, from });
  }
  return { transfers, account };
}

// A create that stopped part way through a transfer would be recorded as
// done, and the next deploy would not finish the transfer.
const newHostError = (params: WorkerScriptParams, transfers: Transfer[]) =>
  `Deploy would move the Durable Object namespaces ${transfers.map((transfer) => `"${transfer.id}" from the Worker ${transfer.from}`).join(", ")} to the Worker ${params.ScriptName}, which this deploy creates. Deploy can move a namespace only to a Worker that exists. Deploy ${params.ScriptName} first without the namespaces, and move them in a later deploy.`;

/**
 * Moves namespaces to the Worker in the three steps that Cloudflare
 * requires:
 * 1. Uploads the Worker with each class expecting its namespace. The upload
 *    leaves out the Worker's bindings to these classes, as Cloudflare
 *    rejects a binding to a namespace that has not arrived.
 * 2. Sets each class as transferred on the Worker that hosts it now.
 *    Cloudflare moves the namespace, with its objects.
 * 3. The caller uploads the Worker again, with the bindings.
 */
async function transferNamespaces(
  params: WorkerScriptParams,
  upload: ScriptUpload,
  transfers: Transfer[],
  account: AccountNamespace[],
): Promise<void> {
  const incoming = new Set(transfers.map((transfer) => transfer.className));
  const expecting: Record<string, DurableObjectExport> = { ...upload.exports };
  for (const transfer of transfers) {
    expecting[transfer.className] = {
      type: "durable-object",
      storage: "sqlite",
      state: "expecting-transfer",
      transfer_from: transfer.from,
    };
  }
  await putScript(params.AccountId, params.ScriptName, {
    ...upload,
    bindings: upload.bindings.filter(
      (binding) =>
        !(
          binding.type === "durable_object_namespace" &&
          binding.script_name === undefined &&
          incoming.has(binding.class_name)
        ),
    ),
    exports: expecting,
  });
  for (const from of new Set(transfers.map((transfer) => transfer.from))) {
    const exports: Record<string, DurableObjectExport> = {};
    for (const namespace of account.filter((other) => other.script === from)) {
      exports[namespace.className] = transfers.some(
        (transfer) =>
          transfer.from === from && transfer.className === namespace.className,
      )
        ? {
            type: "durable-object",
            state: "transferred",
            transferred_to: params.ScriptName,
          }
        : { type: "durable-object", storage: "sqlite" };
    }
    await patchScriptExports(params.AccountId, from, exports);
  }
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
 * namespace. Also returns a message when a namespace could get the objects
 * of another namespace, and when a namespace may move to the Worker in the
 * deploy that renames or deletes another of its namespaces.
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
  const bound = kept?.BoundDurableObjects ?? [];
  // At plan, the list is UNKNOWN_AFTER_APPLY when a dependency has no
  // output yet. Deploy runs the check again with the real params.
  if (!Array.isArray(hosted)) return undefined;

  for (const namespace of before) {
    const moved = bound.find((now) => now.id === namespace.id);
    if (moved && moved.className !== namespace.className) {
      return `The Durable Object namespace "${namespace.id}" would move from the Worker ${previous.ScriptName} to ${moved.scriptName}, and its class would change from ${namespace.className} to ${moved.className}. Deploy can't move a namespace and change its class at once. Move it with the class ${namespace.className}, and change the class in a later deploy.`;
    }
  }

  const lost = before.filter(
    (namespace) =>
      !unprotected.includes(namespace.id) &&
      !hosted.some((now) => now.id === namespace.id) &&
      !bound.some((now) => now.id === namespace.id),
  );
  if (lost.length > 0) {
    const added = hosted.filter(
      (now) => !before.some((other) => other.id === now.id),
    );
    // A new namespace with the class of a lost one is taken as a change of
    // id. When the class changed too, the two can't be paired.
    for (const namespace of lost) {
      const renamed = added.find(
        (now) => now.className === namespace.className,
      );
      if (renamed) {
        return `The id of the Durable Object namespace ${describeHosted(namespace)} of the Worker ${previous.ScriptName} would change to "${renamed.id}". A namespace's id can't change: deploy would delete the namespace with all its objects, which can't be undone. Change the id back to "${namespace.id}".`;
      }
    }
    const declarations = lost
      .map((namespace) => `$durableObject({ id: "${namespace.id}" })`)
      .join(", ");
    const idHint =
      added.length > 0
        ? ` If the id of a namespace changed, change it back.`
        : "";
    return `Deploy would delete the Durable Object namespaces ${lost.map(describeHosted).join(", ")} of the Worker ${previous.ScriptName}, with all their objects, which can't be undone.${idHint} To delete them, first deploy \`protect: false\` on ${declarations} while this Worker still hosts them. To move a namespace to another Worker instead, keep binding it from this Worker.`;
  }

  // Cloudflare keys a namespace by its class name, and so does the move of a
  // bound namespace from this Worker to its new host. A bound namespace may
  // not move, as this Worker may never have hosted it.
  for (const namespace of [...hosted, ...bound]) {
    const taken = before.find(
      (other) =>
        other.className === namespace.className && other.id !== namespace.id,
    );
    if (taken) {
      return `The Durable Object namespace "${namespace.id}" has the class ${taken.className}, which "${taken.id}" had on the Worker ${previous.ScriptName}, so "${namespace.id}" could get the objects of "${taken.id}". Deploy the change to "${taken.id}" first, and this change in a later deploy, or give "${namespace.id}" another class.`;
    }
  }

  // The first upload of a move would apply the renames and deletes. If the
  // move then failed, the next deploy would send them again from the old
  // state. Plan can't tell a move from a new namespace without the
  // account's namespaces, so it rejects both.
  const sources = kept?.DurableObjectTransferSources ?? [];
  const arriving = hosted.filter(
    (namespace) =>
      !before.some((other) => other.id === namespace.id) &&
      sources.some(
        (source) => source.id === namespace.id && source.scriptNames.length > 0,
      ),
  );
  const migrating = Object.entries(
    durableObjectExports(hosted, before, bound),
  ).filter(([, entry]) => "state" in entry);
  if (arriving.length > 0 && migrating.length > 0) {
    return `Deploy may move the Durable Object namespaces ${arriving.map(describeHosted).join(", ")} to the Worker ${previous.ScriptName} from another Worker that binds them, and would also rename or delete the classes ${migrating.map(([className]) => className).join(", ")} of ${previous.ScriptName}. Deploy can't do both in one deploy. Make the two changes in separate deploys.`;
  }
  return undefined;
}

/**
 * Makes the Durable Object `exports` map of the upload. Cloudflare fails an
 * upload that omits a previous namespace, so each one is listed as renamed
 * (same id, new class) or deleted (no longer hosted). A namespace that the
 * Worker binds on another Worker is left out: its new host's deploy, which
 * runs first, moved it there.
 */
export function durableObjectExports(
  hosted: HostedNamespace[],
  previous: HostedNamespace[],
  bound: BoundNamespace[] = [],
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
    if (bound.some((namespace) => namespace.id === before.id)) continue;
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
