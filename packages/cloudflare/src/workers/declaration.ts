import type * as cf from "@cloudflare/workers-types";
import type { BaseResource } from "@notation/resource";

// The runtime build also loads this module, so it must only import types.

/** The outputs required from a resource that `secretsStore.bind()` can bind. */
export type SecretOutput = {
  StoreId: string;
  Name: string;
  SecretId: string;
};

/**
 * A resource with the secret outputs (`StoreId`, `Name`, `SecretId`) that
 * `secretsStore.bind()` reads.
 */
export type SecretTargetResource = BaseResource & {
  outputRef<K extends keyof SecretOutput>(key: K): string;
  readonly output: SecretOutput;
};

/**
 * A secret or token that `secretsStore.bind()` can bind to a Worker.
 * Declared with `secret()` or `accountToken()`.
 */
export interface BindableSecret {
  readonly id: string;
  readonly "~secret": () => SecretTargetResource;
}

/**
 * A `secrets_store_secret` binding produced by `secretsStore.bind()`.
 */
export interface SecretBinding {
  readonly "~secretBinding": BindableSecret;
}

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
 * A value that a Worker can bind: a Durable Object namespace, another Worker
 * (a service binding), a secret from `secretsStore.bind()`, or a string (plain text).
 */
export type BindingValue =
  | string
  | DurableObjectDeclaration<any>
  | SecretBinding
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
    : V extends SecretBinding
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
