import type * as cf from "@cloudflare/workers-types";

// This module is part of both builds. In the runtime build it must not import
// infra code, so it imports only types.

/** A Durable Object class, such as `class Counter extends DurableObject`. */
export type DurableObjectClass = abstract new (...args: any[]) => unknown;

/**
 * A Durable Object namespace, as `$durableObject` declares it. A Worker binds
 * it, and hosts it when the Worker's module exports its class.
 */
export interface DurableObjectDeclaration<
  C extends DurableObjectClass = DurableObjectClass,
> {
  readonly id: string;
  /**
   * Carries the class for the type helpers. It is never set at runtime. It
   * is required in the type, so that another object with an `id` is not
   * taken for a namespace.
   */
  readonly "~durableObject": { class: C };
}

/**
 * A value that a Worker binds by name: a Durable Object namespace, another
 * Worker, which the Worker calls through a service binding, or a string,
 * which the Worker reads as plain text.
 */
export type BindingValue =
  | string
  | DurableObjectDeclaration<any>
  | { readonly "~worker": { bindings: Bindings } };

export type Bindings = Record<string, BindingValue>;

/**
 * A Cloudflare Worker, as `$worker` declares it. Infra and other Workers
 * bind it, and the Worker's code uses its types.
 */
export interface Worker<B extends Bindings = Bindings> {
  readonly id: string;
  /**
   * Carries the bindings for the type helpers. It is never set at runtime.
   * It is required in the type, so that another object with an `id` is not
   * taken for a Worker.
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
    : V extends { readonly "~worker": unknown }
      ? cf.Fetcher
      : string;

/**
 * The `env` that the Worker's handlers receive, from the declaration:
 * `WorkerEnv<typeof worker>`. A Durable Object namespace is a
 * `DurableObjectNamespace` of its class, another Worker is a `Fetcher`, and
 * a string is a string.
 */
export type WorkerEnv<
  W extends { readonly "~worker": { bindings: Bindings } },
> = {
  readonly [K in keyof W["~worker"]["bindings"]]: BindingType<
    W["~worker"]["bindings"][K]
  >;
};

/**
 * The type of the default export of a Worker's module, from the
 * declaration: `export default { fetch(request, env) {} } satisfies
 * WorkerHandler<typeof worker>`.
 */
export type WorkerHandler<
  W extends { readonly "~worker": { bindings: Bindings } },
> = cf.ExportedHandler<WorkerEnv<W>>;
