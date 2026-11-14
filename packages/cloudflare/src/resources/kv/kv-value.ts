import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  type ResourceOperationContext,
} from "@notation/resource";
import { cloudflareCreate } from "src/api/client";
import { deleteKVValue, getKVValue, isNotFound, putKVValue } from "src/api/kv";
import type { KVNamespaceInstance } from "./kv-namespace";

type KVValueKey = { AccountId: string; NamespaceId: string; Key: string };

export type KVValueSchema = {
  Key: KVValueKey;
  CreateParams: KVValueKey & { Value: string };
  UpdateParams: { Value: string };
  ReadResult: {};
};

export type KVValueDependencies = {
  namespace: KVNamespaceInstance;
};

const kvValue = resource<KVValueSchema>({
  type: "cloudflare/kv/KVValue",
  provider: "@notation/cloudflare/resources",
  // A replace changes the key, the namespace or the account, so the new key
  // never collides with the old one.
  replaceCreatesFirst: true,
});

const kvValueSchema = kvValue.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  NamespaceId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  /**
   * The key's name: 1 to 512 bytes, and not `.` or `..`. A change writes the
   * new key, then deletes the old key at the end of the deploy. If the new
   * key already exists, the deploy fails and the old key stays as it was.
   */
  Key: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.pipe(
      v.string(),
      v.minBytes(1),
      v.maxBytes(512),
      v.check(
        (key) => key !== "." && key !== "..",
        "A KV key can't be . or ..",
      ),
    ),
  },
  /**
   * The value, stored as it is. To store JSON, pass `JSON.stringify(value)`.
   * Cloudflare allows up to 25 MiB, but state holds the value in both the
   * params and the outputs, so keep large values in R2.
   */
  Value: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.string(), v.maxBytes(25 * 1024 * 1024)),
  },
} as const);

// With the default of 30 attempts, a write waits up to about 60 seconds, the
// time that Cloudflare gives for a write to reach every location.
const WRITE_CHECK_INTERVAL_MS = 2_000;

/**
 * Reads the key until it returns the written value. KV is eventually
 * consistent, so the read can return an older value, or no value for a new
 * key. Until then, this throws a pending error with `Written` in its
 * callback context, and the reconciler calls the operation again. The next
 * attempt only reads.
 *
 * Without the wait, the read that the reconciler makes after a create could
 * find no key and fail the deploy, and the read after an update could record
 * the old value in the outputs.
 *
 * If the read never returns the written value, a create fails with no state
 * record, and the key stays in KV with the written value.
 */
async function confirmWrite(
  params: KVValueKey & { Value: string },
): Promise<void> {
  const { AccountId, NamespaceId, Key, Value } = params;
  const stored = await getKVValue(AccountId, NamespaceId, Key);
  if (stored !== Value) {
    throw new ResourceOperationPendingError(
      `The KV key ${JSON.stringify(Key)} doesn't return the written value yet. If it still doesn't after about a minute, something else, such as a Worker, may be writing the key.`,
      {
        retryAfterMs: WRITE_CHECK_INTERVAL_MS,
        callbackContext: { Written: true },
      },
    );
  }
}

const keyTakenMessage = (key: KVValueKey) =>
  `The KV namespace ${key.NamespaceId} in the Cloudflare account ${key.AccountId} already has the key ${JSON.stringify(key.Key)}. Give this KVValue another key, or delete the existing key and deploy again. If a previous deploy failed partway, the key may be the one it wrote, so check it before you delete it. A key deleted in the last minute can still read as existing.`;

/**
 * The value of a key in a Workers KV namespace. Create fails when the key
 * already exists, rather than overwrite it. Delete deletes the key.
 *
 * Read gets the value from Cloudflare. A read within about 60 seconds of a
 * write made elsewhere can return the older value. Deploy then plans an
 * update, which writes the value in code again.
 */
export const KVValue = kvValueSchema
  .defineOperations({
    // Check first, so that create doesn't overwrite a key that existed
    // before. An attempt after this create's own write skips the check,
    // because it would find that write. The check is outside
    // `cloudflareCreate`: if it throws, nothing was written.
    create: async (params, context) => {
      const { AccountId, NamespaceId, Key, Value } = params;
      let written = Boolean(context?.Written);
      try {
        if (!written) {
          if ((await getKVValue(AccountId, NamespaceId, Key)) !== undefined) {
            throw new Error(keyTakenMessage(params));
          }
          await cloudflareCreate(putKVValue)(
            AccountId,
            NamespaceId,
            Key,
            Value,
          );
          written = true;
        }
        await confirmWrite(params);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        // A namespace created in the same deploy can be missing from the KV
        // calls for a few seconds after the namespace calls return it.
        throw new ResourceOperationPendingError(
          `The KV namespace ${NamespaceId} in the Cloudflare account ${AccountId} isn't found yet. If it is still missing after about a minute, it may have been deleted outside notation.`,
          {
            retryAfterMs: WRITE_CHECK_INTERVAL_MS,
            cause: error,
            ...(written ? { callbackContext: { Written: true } } : {}),
          },
        );
      }
    },

    read: async (key) => {
      let value: string | undefined;
      try {
        value = await getKVValue(key.AccountId, key.NamespaceId, key.Key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (value === undefined) {
        throw new ResourceNotFoundError("KV key was not found");
      }
      return { ...key, Value: value };
    },

    update: async (key, _patch, params, _state, context) => {
      const { AccountId, NamespaceId, Key } = key;
      if (!context?.Written) {
        await putKVValue(AccountId, NamespaceId, Key, params.Value);
      }
      await confirmWrite({ ...key, Value: params.Value });
    },

    // The namespace may be gone, with its keys, when it was replaced or
    // deleted before the key.
    delete: async (key) => {
      try {
        await deleteKVValue(key.AccountId, key.NamespaceId, key.Key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  })
  .requireDependencies<KVValueDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.namespace.output.AccountId,
    NamespaceId: deps.namespace.output.NamespaceId,
  }));

export type KVValueInstance = InstanceType<typeof KVValue>;
