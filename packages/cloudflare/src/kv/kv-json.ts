import {
  ResourceGroup,
  type BaseResource,
  type ContributionFunction,
  type StandardSchemaV1,
} from "@notation/resource";
import { assertId, type IdOption } from "@notation/utils";
import type { Json } from "src/json";
import type { KVNamespaceInstance } from "src/resources/kv/kv-namespace";
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
 * `T` where it is JSON, `unknown` or `any`, and `never` where it is not. An
 * interface passes, though it has no index signature and so isn't assignable
 * to `Json`. `unknown` passes at any depth, such as the rest of a loose
 * object, because the validator of `KVJsonValue` checks what deploy writes.
 * A type assignable to `Json`, such as a recursive JSON type, passes without
 * being walked.
 */
type JsonInput<T> = unknown extends T
  ? T
  : T extends Json
    ? T
    : T extends (...args: any[]) => unknown
      ? never
      : T extends object
        ? { [K in keyof T]: JsonInput<T[K]> }
        : never;

type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;

type Values<M> = M[keyof M];

// Named at their own key, rather than at one of their methods.
type BuiltIn =
  Date | RegExp | Map<unknown, unknown> | Set<unknown> | Promise<unknown>;

/**
 * The paths of the keys in `T` that aren't JSON, such as `"a.b"`,
 * `"list[]"` or `"map[string]"`, or `""` for `T` itself. It stops at a depth
 * of 8, as a recursive type would not end. It is only computed for an error
 * message, so it lets `undefined` through, as from an optional key.
 */
type NonJsonPath<T, P extends string = "", D extends number = 8> = [D] extends [
  never,
]
  ? never
  : unknown extends T
    ? never
    : T extends Json | undefined
      ? never
      : T extends ((...args: any[]) => unknown) | BuiltIn
        ? P
        : T extends readonly (infer E)[]
          ? NonJsonPath<E, `${P}[]`, Depth[D]>
          : T extends object
            ? | Values<{
                  [
                    K in keyof T as string extends K
                      ? never
                      : number extends K
                        ? never
                        : K
                  ]-?: NonJsonPath<T[K], Join<P, K & string>, Depth[D]>;
                }>
              | (string extends keyof T
                  ? NonJsonPath<T[string & keyof T], `${P}[string]`, Depth[D]>
                  : never)
            : P;

type NonJsonError<P> = [P] extends [never]
  ? "kvJson(): the input type of the schema must be JSON"
  : P extends ""
    ? "kvJson(): the input type of the schema must be JSON"
    : `kvJson(): the input type of the schema must be JSON, but the key ${P & string} isn't`;

/**
 * `S` when the input type of the schema `S` is JSON, and otherwise an error
 * message that names the first key that isn't JSON. `unknown` and `any` are
 * JSON at any depth here; see `JsonInput`. Its output type can be any type.
 */
type JsonSchemaCheck<S extends JsonInputSchema> =
  Input<S> extends JsonInput<Input<S>>
    ? S
    : NonJsonError<NonJsonPath<Input<S>>>;

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
   * `readKVJson()`. Its input type must be JSON, though `unknown` is allowed
   * at any depth, as in a loose object.
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

  constructor({ id, namespace, key, schema: checked, value }: KVJsonConfig<S>) {
    assertId("kvJson()", id);
    // The type check leaves `S`, or an error message that no value matches.
    const schema = checked as S;
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
