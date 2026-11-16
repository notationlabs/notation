import * as v from "valibot";
import { mergeContributions, resource } from "@notation/resource";
import { sortedJson } from "@notation/utils";
import { jsonSchema, type Json } from "src/json";
import type { KVNamespaceInstance } from "./kv-namespace";
import { kvOperations, type KVEncoding, type KVKey } from "./kv-operations";

export type KVJsonValueSchema = {
  Key: KVKey;
  CreateParams: KVKey & { Value: Json };
  UpdateParams: { Value: Json };
  ReadResult: {};
};

export type KVJsonValueDependencies = {
  namespace: KVNamespaceInstance;
};

const kvJsonValue = resource<KVJsonValueSchema>({
  type: "cloudflare/kv/KVJsonValue",
  provider: "@notation/cloudflare/resources",
  // A replace changes the key, the namespace or the account, so the new key
  // never collides with the old one.
  replaceCreatesFirst: true,
});

const kvJsonValueSchema = kvJsonValue.defineSchema({
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
   * The value, a JSON value that `JSON.stringify` writes as it is. Deploy
   * stores the text of `sortedJson.encode`, which is at most 25 MiB. Any
   * code can add object keys to it with `contribute`. State holds the value
   * in both the params and the outputs, so keep large values in R2.
   */
  Value: {
    propertyType: "param",
    presence: "required",
    value: jsonSchema({ maxBytes: 25 * 1024 * 1024 }),
    collect: mergeContributions<Json>,
  },
} as const);

// Text that is not JSON reads as a JSON string. It differs from the value in
// code, so plan shows an update and deploy writes the key again. A read that
// threw would stop every deploy until the key was fixed by hand.
const jsonEncoding: KVEncoding<Json> = {
  encode: (value) => sortedJson.encode(value),
  decode: (text) => {
    try {
      return sortedJson.decode(text) as Json;
    } catch {
      return text;
    }
  },
};

/**
 * A JSON value in a key of a Workers KV namespace. `kvJson()` in
 * `@notation/cloudflare/kv` declares one with a schema. Create fails when the
 * key already exists, rather than overwrite it. Delete deletes the key.
 *
 * Read parses the stored text. A read within about 60 seconds of a write
 * made elsewhere can return the older value. Deploy then plans an update,
 * which writes the value in code again.
 */
export const KVJsonValue = kvJsonValueSchema
  .defineOperations(kvOperations("KVJsonValue", jsonEncoding))
  .requireDependencies<KVJsonValueDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.namespace.output.AccountId,
    NamespaceId: deps.namespace.output.NamespaceId,
  }));

export type KVJsonValueInstance = InstanceType<typeof KVJsonValue>;
