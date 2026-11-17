import type * as cf from "@cloudflare/workers-types";
import type { CredentialRef, Input } from "@notation/resource";
import type { Json } from "src/json";
import type { KVNamespaceInstance } from "src/resources/kv/kv-namespace";
import type { R2BucketInstance } from "src/resources/r2/r2-bucket";
import type { SecretsStoreSecretInstance } from "src/resources/secrets-store/secrets-store-secret";

// The runtime build also loads this module, so it must only import types.

export type { Json };

/** A Durable Object class, such as `class Counter extends DurableObject`. */
export type DurableObjectClass = abstract new (...args: any[]) => unknown;

/** A Durable Object namespace declared with `$durableObject`. */
export interface DurableObjectDeclaration<
  C extends DurableObjectClass = DurableObjectClass,
> {
  readonly id: string;
  /**
   * Exists only in the type. It is required, so that an arbitrary object
   * with an `id` is not accepted as a namespace.
   */
  readonly "~durableObject": { class: C };
}

/** A JSON binding, from `json(value)`. */
export interface JsonBinding<T = Json> {
  readonly "~json": T;
}

/**
 * `T` if it is a JSON value, and `never` where it is not. An interface has no
 * index signature, so it is not assignable to `Json`, but it passes this
 * check.
 */
export type JsonValue<T> = T extends string | number | boolean | null
  ? T
  : T extends (...args: any[]) => unknown
    ? never
    : T extends object
      ? { [K in keyof T]: JsonValue<T[K]> }
      : never;

/**
 * A value that a Worker can bind: a Durable Object namespace, another Worker
 * (a service binding), a credential of a resource (a Worker secret), a
 * `SecretsStoreSecret`, an R2 bucket, a KV namespace, a value from `json()`,
 * or a string (plain text). A plain text binding can be an output ref or a
 * derived value, such as `` text`${api.url}/callback` ``, which deploy fills
 * in.
 */
export type BindingValue =
  | Input<string>
  | CredentialRef<string>
  | DurableObjectDeclaration<any>
  | SecretsStoreSecretInstance
  | R2BucketInstance
  | KVNamespaceInstance
  | JsonBinding<any>
  | { readonly "~worker": { bindings: Bindings } };

export type Bindings = Record<string, BindingValue>;

/**
 * A Cloudflare Worker declared with `$worker` or `worker()`. `E` is the type
 * of the class that the Worker's module exports as its default, from the
 * `entrypoint` option. In `B`, `$worker` and `worker()` replace each output
 * ref, credential and derived value with the type of its value, so that the
 * type of an exported Worker names no type of `@notation/resource`.
 *
 * `E` has no constraint. The class's `env` type depends on the Worker's
 * type, and with a constraint TypeScript resolves the class's base type
 * while it is still resolving it, which fails.
 */
export interface Worker<B extends Bindings = Bindings, E = unknown> {
  readonly id: string;
  /**
   * Exists only in the type. It is required, so that an arbitrary object
   * with an `id` is not accepted as a Worker.
   */
  readonly "~worker": { bindings: B; entrypoint: E };
}

/**
 * Names the type of an entrypoint class where the class's value can't be
 * loaded, from `entrypointType()`. It exists only in the type.
 */
export interface EntrypointType<E> {
  readonly "~entrypoint": E;
}

// A Worker whose entrypoint is a `WorkerEntrypoint` class gets RPC types.
// Any other Worker, or one with no entrypoint, gets a plain `Fetcher`.
type ServiceOf<E> = E extends new (
  ...args: any[]
) => cf.Rpc.WorkerEntrypointBranded
  ? cf.Service<E>
  : cf.Fetcher;

type NamespaceOf<C> = C extends abstract new (...args: any[]) => infer I
  ? I extends cf.Rpc.DurableObjectBranded
    ? cf.DurableObjectNamespace<I>
    : cf.DurableObjectNamespace
  : never;

type ClassOf<V> = V extends DurableObjectDeclaration<infer C> ? C : never;

type BindingType<V> =
  V extends DurableObjectDeclaration<any>
    ? NamespaceOf<ClassOf<V>>
    : V extends { readonly "~worker": { entrypoint: infer E } }
      ? ServiceOf<E>
      : V extends JsonBinding<infer T>
        ? T
        : V extends R2BucketInstance
          ? cf.R2Bucket
          : V extends KVNamespaceInstance
            ? cf.KVNamespace
            : V extends SecretsStoreSecretInstance
              ? cf.SecretsStoreSecret
              : string;

/**
 * The `env` type of a Worker's handlers: `WorkerEnv<typeof worker>`. A
 * binding to a string, an output ref, a derived value or a credential is a
 * `string`.
 */
export type WorkerEnv<
  W extends { readonly "~worker": { bindings: Bindings } },
> = {
  readonly [K in keyof W["~worker"]["bindings"]]: BindingType<
    W["~worker"]["bindings"][K]
  >;
};

/**
 * The type of the default export of a Worker's module:
 * `export default { ... } satisfies WorkerHandler<typeof worker>`.
 */
export type WorkerHandler<
  W extends { readonly "~worker": { bindings: Bindings } },
> = cf.ExportedHandler<WorkerEnv<W>>;
