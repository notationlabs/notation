import {
  ResourceGroup,
  type BaseResource,
  type ContributionFunction,
  type StandardSchemaV1,
} from "@notation/resource";
import { assertId, type IdOption } from "@notation/utils";
import type { Json } from "src/json";
import type { KVNamespaceInstance } from "src/resources/kv/kv-namespace";
import type { JsonValue } from "src/workers/declaration";
import {
  KVJsonValue,
  type KVJsonValueInstance,
} from "src/resources/kv/kv-json-value";

/**
 * `T` with each object key optional, at every depth. An array or a scalar
 * stays whole, because contributions set them whole.
 */
export type JsonPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: JsonPartial<T[K]> }
    : T;

type JsonInputSchema = StandardSchemaV1<unknown, unknown>;

type Input<S extends JsonInputSchema> = StandardSchemaV1.InferInput<S>;

/**
 * `S` when the input type of the schema `S` is JSON or `unknown`, and an
 * error otherwise. It uses `JsonValue` rather than `Json`, so an input typed as
 * an interface passes. `JsonValue<unknown>` is `never`, so `unknown` is let
 * through first; the class's validator still checks what deploy writes. Its
 * output type can be any type.
 */
type JsonSchemaCheck<S extends JsonInputSchema> =
  unknown extends Input<S>
    ? S
    : Input<S> extends JsonValue<Input<S>>
      ? S
      : S & { "~error": "The input type of the schema must be JSON" };

export type KVJsonConfig<S extends JsonInputSchema = JsonInputSchema> = {
  /**
   * Keys the document in state. The resource's id is `kv-json:<id>`.
   * Cloudflare never sees it. Must be name-safe: 1 to 64 letters, digits,
   * hyphens or underscores. A new id is a new resource, so keep it stable.
   */
  id: string;
  /** The namespace that holds the key. */
  namespace: KVNamespaceInstance;
  /** The KV key. */
  key: string;
  /**
   * Validates the document at plan and deploy, after the contributions are
   * merged. Import it from a shared module, so that a Worker can pass it to
   * `readKVJson()`. Its input type must be JSON.
   */
  schema: JsonSchemaCheck<S>;
  /** The first part of the document, before the contributions. */
  value?: JsonPartial<Input<S>>;
};

/**
 * A JSON document in a KV key, from `kvJson()`. Any code can add object keys
 * to it with `contribute`.
 */
export class KVJsonGroup<
  S extends JsonInputSchema = JsonInputSchema,
> extends ResourceGroup<{ id: string; key: string }> {
  platform = "cloudflare";
  readonly schema: S;
  readonly value: KVJsonValueInstance;

  constructor({ id, namespace, key, schema, value }: KVJsonConfig<S>) {
    assertId("kvJson()", id);
    if (typeof schema?.["~standard"]?.validate !== "function") {
      throw new Error(
        `kvJson() "${id}" requires a schema: a Standard Schema, such as a valibot or Zod schema, imported from a shared module.`,
      );
    }
    super("cloudflare/kv/json", id, { id, key });
    this.schema = schema;
    this.value = this.add(
      new KVJsonValue(`kv-json:${id}`, {
        config: { Key: key, Value: value as Json | undefined },
        dependencies: { namespace },
        checks: { Value: schema },
      }),
    );
  }

  /**
   * Adds keys to the document. Contributions merge object keys at every
   * depth. Two that set one key to different values conflict, and plan fails.
   * An array or a scalar is set whole. With a function and its deps, the
   * function computes the keys from the deps' outputs.
   */
  contribute(value: JsonPartial<Input<S>>): void;
  contribute<Deps extends Record<string, BaseResource>>(
    compute: ContributionFunction<Deps, JsonPartial<Input<S>>>,
    options: { deps: Deps },
  ): void;
  contribute(
    input: unknown,
    options?: { deps: Record<string, BaseResource> },
  ): void {
    if (typeof input === "function") {
      const compute = input as ContributionFunction<any, Json>;
      this.value.contribute((context) => ({ Value: compute(context) }), {
        deps: options?.deps ?? {},
      });
      return;
    }
    this.value.contribute({ Value: input as Json });
  }
}

/**
 * Declares a JSON document in a KV key. `id` must be a name-safe string
 * literal; see `NameSafe`. The document is `value`, if given, merged with
 * every contribution. Plan and deploy check it against `schema` before they
 * write it. A Worker reads it with `readKVJson()`.
 * @resource runtime: schema
 */
export function kvJson<
  S extends JsonInputSchema,
  const Id extends string = never,
>(config: Omit<KVJsonConfig<S>, "id"> & { id: IdOption<Id> }): KVJsonGroup<S> {
  return new KVJsonGroup(config);
}
