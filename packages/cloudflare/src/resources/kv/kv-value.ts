import * as v from "valibot";
import { resource } from "@notation/resource";
import type { KVNamespaceInstance } from "./kv-namespace";
import { kvOperations, textEncoding, type KVKey } from "./kv-operations";

export type KVValueSchema = {
  Key: KVKey;
  CreateParams: KVKey & { Value: string };
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

/**
 * The value of a key in a Workers KV namespace. Create fails when the key
 * already exists, rather than overwrite it. Delete deletes the key.
 *
 * Read gets the value from Cloudflare. A read within about 60 seconds of a
 * write made elsewhere can return the older value. Deploy then plans an
 * update, which writes the value in code again.
 */
export const KVValue = kvValueSchema
  .defineOperations(kvOperations("KVValue", textEncoding))
  .requireDependencies<KVValueDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.namespace.output.AccountId,
    NamespaceId: deps.namespace.output.NamespaceId,
  }));

export type KVValueInstance = InstanceType<typeof KVValue>;
