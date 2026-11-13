import type * as cf from "@cloudflare/workers-types";

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

/**
 * A value that a Worker can bind: a Durable Object namespace, another Worker
 * (a service binding), a secret from `secretsStore.bind()` or a string
 * (plain text).
 */
export type BindingValue =
  | string
  | DurableObjectDeclaration<any>
  | SecretsStoreSecretBinding
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
