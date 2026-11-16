import * as v from "valibot";
import {
  ResourceNotFoundError,
  ResourceOperationPendingError,
  type DefineResourceMeta,
  type ResourceOperationContext,
} from "@notation/resource";
import { cloudflareCreate } from "src/api/client";
import { deleteKVValue, getKVValue, isNotFound, putKVValue } from "src/api/kv";
import type { KVNamespaceInstance } from "./kv-namespace";

export type KVKey = { AccountId: string; NamespaceId: string; Key: string };

export type KVKeyDependencies = {
  namespace: KVNamespaceInstance;
};

/** The `resource()` meta of a class that stores a value in one KV key. */
export const kvResourceMeta = (className: string): DefineResourceMeta => ({
  type: `cloudflare/kv/${className}`,
  provider: "@notation/cloudflare/resources",
  // A replace changes the key, the namespace or the account, so the new key
  // never collides with the old one.
  replaceCreatesFirst: true,
});

/** The schema items that locate a class's KV key. */
export const kvKeyParams = {
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
} as const;

/** Takes the account and the namespace of the key from the namespace. */
export const deriveKVKeyParams = async ({
  deps,
}: {
  deps: KVKeyDependencies;
}) => ({
  AccountId: deps.namespace.output.AccountId,
  NamespaceId: deps.namespace.output.NamespaceId,
});

/** How a class stores its `Value` as the text of a key. */
export type KVEncoding<V> = {
  encode(value: V): string;
  decode(text: string): V;
};

export const textEncoding: KVEncoding<string> = {
  encode: (value) => value,
  decode: (text) => text,
};

// With the default of 30 attempts, a write waits up to about 60 seconds, the
// time that Cloudflare gives for a write to reach every location.
const WRITE_CHECK_INTERVAL_MS = 2_000;

/**
 * Reads the key until it returns the written text. KV is eventually
 * consistent, so the read can return an older value, or no value for a new
 * key. Until then, this throws a pending error with `Written` in its
 * callback context, and the reconciler calls the operation again. The next
 * attempt only reads.
 *
 * Without the wait, the read that the reconciler makes after a create could
 * find no key and fail the deploy, and the read after an update could record
 * the old value in the outputs.
 *
 * If the read never returns the written text, a create fails with no state
 * record, and the key stays in KV with the written text.
 */
async function confirmWrite(
  className: string,
  key: KVKey,
  text: string,
): Promise<void> {
  const { AccountId, NamespaceId, Key } = key;
  const stored = await getKVValue(AccountId, NamespaceId, Key);
  if (stored !== text) {
    throw new ResourceOperationPendingError(
      `The KV key ${JSON.stringify(Key)} of the ${className} doesn't return the written value yet. If it still doesn't after about a minute, something else, such as a Worker, may be writing the key.`,
      {
        retryAfterMs: WRITE_CHECK_INTERVAL_MS,
        callbackContext: { Written: true },
      },
    );
  }
}

const keyTakenMessage = (className: string, key: KVKey) =>
  `The KV namespace ${key.NamespaceId} in the Cloudflare account ${key.AccountId} already has the key ${JSON.stringify(key.Key)}. Give this ${className} another key, or delete the existing key and deploy again. If a previous deploy failed partway, the key may be the one it wrote, so check it before you delete it. A key deleted in the last minute can still read as existing.`;

/**
 * The operations of a resource that stores its `Value` param in one KV key,
 * as the text that `encoding` gives. `className`, such as `KVValue`, names
 * the resource in messages.
 *
 * Create fails when the key already exists, rather than overwrite it. Read
 * decodes the stored text. Delete deletes the key.
 */
export function kvOperations<V>(className: string, encoding: KVEncoding<V>) {
  return {
    // Check first, so that create doesn't overwrite a key that existed
    // before. An attempt after this create's own write skips the check,
    // because it would find that write. The check is outside
    // `cloudflareCreate`: if it throws, nothing was written.
    create: async (
      params: KVKey & { Value: V },
      context?: ResourceOperationContext,
    ): Promise<void> => {
      const { AccountId, NamespaceId, Key, Value } = params;
      const text = encoding.encode(Value);
      let written = Boolean(context?.Written);
      try {
        if (!written) {
          if ((await getKVValue(AccountId, NamespaceId, Key)) !== undefined) {
            throw new Error(keyTakenMessage(className, params));
          }
          await cloudflareCreate(putKVValue)(AccountId, NamespaceId, Key, text);
          written = true;
        }
        await confirmWrite(className, params, text);
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

    read: async (key: KVKey): Promise<KVKey & { Value: V }> => {
      let text: string | undefined;
      try {
        text = await getKVValue(key.AccountId, key.NamespaceId, key.Key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (text === undefined) {
        throw new ResourceNotFoundError("KV key was not found");
      }
      return { ...key, Value: encoding.decode(text) };
    },

    update: async (
      key: KVKey,
      _patch: unknown,
      params: { Value: V },
      _state: unknown,
      context?: ResourceOperationContext,
    ): Promise<void> => {
      const { AccountId, NamespaceId, Key } = key;
      const text = encoding.encode(params.Value);
      if (!context?.Written) {
        await putKVValue(AccountId, NamespaceId, Key, text);
      }
      await confirmWrite(className, key, text);
    },

    // The namespace may be gone, with its keys, when it was replaced or
    // deleted before the key.
    delete: async (key: KVKey): Promise<void> => {
      try {
        await deleteKVValue(key.AccountId, key.NamespaceId, key.Key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}
