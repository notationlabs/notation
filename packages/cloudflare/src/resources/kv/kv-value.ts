import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  type ResourceOperationContext,
} from "@notation/resource";
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
   * new key, then deletes the old one.
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
   * The value, stored as it is. Up to 25 MiB. To store JSON, pass
   * `JSON.stringify(value)`.
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
 * Writes the value, then reads it back. KV is eventually consistent, so the
 * read can return an older value, or no value for a new key. Until the read
 * returns the written value, the write throws a pending error, and the
 * reconciler calls it again. The next attempt only reads.
 *
 * Without the wait, the read that the reconciler makes after a create could
 * find no key and fail the deploy, and the read after an update could record
 * the old value in the outputs.
 */
async function writeValue(
  params: KVValueKey & { Value: string },
  context?: ResourceOperationContext,
): Promise<void> {
  const { AccountId, NamespaceId, Key, Value } = params;
  if (!context?.Written) {
    await putKVValue(AccountId, NamespaceId, Key, Value);
  }
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

/**
 * The value of a key in a Workers KV namespace. Create overwrites a value
 * that the key already has. Delete deletes the key.
 *
 * Read gets the value from Cloudflare. A read within about 60 seconds of a
 * write made elsewhere can return the older value. Deploy then plans an
 * update, which writes the value in code again.
 */
export const KVValue = kvValueSchema
  .defineOperations({
    create: async (params, context) => {
      await writeValue(params, context);
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
      await writeValue({ ...key, Value: params.Value }, context);
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
