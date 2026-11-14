import type * as cf from "@cloudflare/workers-types";
import type { KVNamespaceInstance } from "src/resources/kv/kv-namespace";
import type { R2BucketInstance } from "src/resources/r2/r2-bucket";

// The runtime build also loads this module, so it must only import types.

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

/**
 * A secret that `secretsStore.bind()` binds, from `secret()` or
 * `accountToken()`. The hook gives the resource whose outputs say where the
 * secret is.
 */
export interface BindableSecret {
  "~secret"(): {
    outputRef(key: "StoreId" | "Name" | "SecretId"): string;
  };
}

/** A Secrets Store secret binding, from `secretsStore.bind(secret)`. */
export interface SecretsStoreSecretBinding {
  readonly "~secretsStoreSecret": BindableSecret;
}

/** A JSON binding, from `json(value)`. */
export interface JsonBinding<T extends Json = Json> {
  readonly "~json": T;
}

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/** A secret declared with `workerSecret()`. */
export interface WorkerSecret {
  readonly "~workerSecret": true;
}

/**
 * A value that a Worker can bind: a Durable Object namespace, another Worker
 * (a service binding), a secret from `secretsStore.bind()` or
 * `workerSecret()`, an R2 bucket, a KV namespace, a value from `json()` or a
 * string (plain text).
 */
export type BindingValue =
  | string
  | DurableObjectDeclaration<any>
  | SecretsStoreSecretBinding
  | WorkerSecret
  | R2BucketInstance
  | KVNamespaceInstance
  | JsonBinding<any>
  | { readonly "~worker": { bindings: Bindings } };

export type Bindings = Record<string, BindingValue>;

/** A Cloudflare Worker declared with `$worker`. */
export interface Worker<B extends Bindings = Bindings> {
  readonly id: string;
  /**
   * Exists only in the type. It is required, so that an arbitrary object
   * with an `id` is not accepted as a Worker.
   */
  readonly "~worker": { bindings: B };
}

type NamespaceOf<C> = C extends abstract new (...args: any[]) => infer I
  ? I extends cf.Rpc.DurableObjectBranded
    ? cf.DurableObjectNamespace<I>
    : cf.DurableObjectNamespace
  : never;

type ClassOf<V> = V extends DurableObjectDeclaration<infer C> ? C : never;

type BindingType<V> =
  V extends DurableObjectDeclaration<any>
    ? NamespaceOf<ClassOf<V>>
    : V extends SecretsStoreSecretBinding
      ? cf.SecretsStoreSecret
      : V extends { readonly "~worker": unknown }
        ? cf.Fetcher
        : V extends JsonBinding<infer T>
          ? T
          : V extends R2BucketInstance
            ? cf.R2Bucket
            : V extends KVNamespaceInstance
              ? cf.KVNamespace
              : string;

/** The `env` type of a Worker's handlers: `WorkerEnv<typeof worker>`. */
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
