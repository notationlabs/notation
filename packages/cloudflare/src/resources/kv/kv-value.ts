import * as v from "valibot";
import { resource } from "@notation/resource";
import {
  deriveKVKeyParams,
  kvKeyParams,
  kvOperations,
  kvResourceMeta,
  textEncoding,
  type KVKey,
  type KVKeyDependencies,
} from "./kv-operations";

export type KVValueSchema = {
  Key: KVKey;
  CreateParams: KVKey & { Value: string };
  UpdateParams: { Value: string };
  ReadResult: {};
};

export type KVValueDependencies = KVKeyDependencies;

const kvValueSchema = resource<KVValueSchema>(
  kvResourceMeta("KVValue"),
).defineSchema({
  ...kvKeyParams,
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
  .deriveParams(deriveKVKeyParams);

export type KVValueInstance = InstanceType<typeof KVValue>;
