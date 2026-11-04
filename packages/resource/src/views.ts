/**
 * A handler that a provider's `handle.<kind>(fn)` returns. Runtime code and
 * tests call it like `fn`. `E` is the event, `R` the result, and `F` the
 * provider's function type, such as `LambdaGroup`.
 *
 * The mark lets `InfraView` tell a handler from other exported functions.
 * Like every mark in this file, it exists only in types: no value has it at
 * runtime. The keys are strings, not symbols, so declaration emit can name
 * them in the inferred types of user exports. "~" sorts them last in
 * completions, as Standard Schema's "~standard" does.
 */
export type Handler<E, R, F> = ((event: E, context?: unknown) => Promise<R>) & {
  readonly "~notation.handler": { event: E; result: R; function: F };
};

/**
 * How infra sees a handler that it imports `with { type: "runtime" }`. Infra
 * APIs such as `route()` and `consume()` take one. It is not callable.
 * `function` is the function that the handler belongs to.
 *
 * A ref of event `E` is assignable to a ref of event `E2` only when `E2` is
 * assignable to `E`, so wiring a handler to the wrong source is a type error.
 */
export type RuntimeRef<E, R, F> = {
  readonly function: F;
  readonly "~notation.runtimeRef": {
    readonly event: (event: E) => void;
    readonly result: R;
  };
};

/**
 * Marks the result of a function factory called in a runtime module, such as
 * `lambda()`. Infra sees an exported result as the function `F`.
 */
export type FunctionDeclaration<F> = { readonly "~notation.function": F };

/**
 * Marks a resource factory with the signature that runtime code sees, when
 * it differs from the factory's own. `lambda()` is marked with a signature
 * that returns what its runtime half returns, `{ handle }`.
 */
export type RuntimeFactory<F extends AnyFunction> = {
  readonly "~notation.runtimeFactory"?: F;
};

/**
 * Marks the result of a method, such as a queue's `grant()`, that runtime
 * code may call, because the settings of `lambda()` use it.
 */
export type Grant<T> = T & { readonly "~notation.grant"?: true };

/**
 * How runtime code sees an infra function or method that it can't call. Only
 * resource factories and `grant` methods are callable from runtime code.
 */
export type InfraOnly<Name extends PropertyKey> = {
  readonly "~notation.infraOnly": Name;
};

/**
 * How infra sees an export of a runtime module that isn't a handler or a
 * declared function, such as a helper. Infra can't use it.
 */
export type RuntimeOnly<Name extends PropertyKey> = {
  readonly "~notation.runtimeOnly": Name;
};

type AnyFunction = (...args: any) => any;
type AnyClass = abstract new (...args: any) => any;

// A resource group, matched by shape so that two copies of this package
// still match.
type ResourceGroupShape = {
  readonly type: string;
  readonly id: string;
  readonly resources: readonly object[];
};

// A factory's result: a resource group, or a function declaration such as
// `lambda()`'s.
type FactoryResult = ResourceGroupShape | FunctionDeclaration<unknown>;

type IsGrant<F extends AnyFunction> =
  "~notation.grant" extends keyof ReturnType<F> ? true : false;

/**
 * How runtime code sees an infra module that it imports
 * `with { type: "infra" }`. Data keeps its type: an output value, such as a
 * queue's `url`, is the value it is filled in with. Functions become
 * `InfraOnly`, except resource factories and `grant` methods. A factory
 * returns its result as a binding: only its data and `grant` methods are
 * usable. A factory marked with `RuntimeFactory` has the marked signature.
 */
export type RuntimeView<T> = {
  readonly [K in keyof T]: T[K] extends AnyClass
    ? InfraOnly<K>
    : T[K] extends AnyFunction
      ? "~notation.runtimeFactory" extends keyof T[K]
        ? NonNullable<T[K]["~notation.runtimeFactory" & keyof T[K]]>
        : ReturnType<T[K]> extends FactoryResult
          ? (...args: Parameters<T[K]>) => BindingView<ReturnType<T[K]>>
          : InfraOnly<K>
      : BindingView<T[K]>;
};

/**
 * How runtime code sees a binding of an infra module. It keeps what the
 * function can be given: output values, primitives, and plain data, such as
 * a queue's `url`, `arn`, `id` and `config`. Properties that hold anything
 * else, such as the queue's resources, are left out. Methods become
 * `InfraOnly`, except `grant` methods.
 */
type BindingView<T> = T extends AnyFunction
  ? T
  : T extends object
    ? {
        readonly [
          K in keyof T as T[K] extends AnyFunction
            ? K
            : IsData<T[K]> extends true
              ? K
              : never
        ]: T[K] extends AnyFunction
          ? IsGrant<T[K]> extends true
            ? T[K]
            : InfraOnly<K>
          : T[K];
      }
    : T;

// Whether a value of type T is data that a function can be given. An object
// with methods, such as a resource, isn't.
type IsData<T> = T extends string | number | boolean | null | undefined
  ? true
  : T extends AnyFunction
    ? false
    : T extends readonly (infer U)[]
      ? IsData<U>
      : T extends object
        ? true extends HasMethod<T>
          ? false
          : false extends AllData<T>
            ? false
            : true
        : false;

type HasMethod<T> = {
  [K in keyof T]-?: T[K] extends AnyFunction ? true : false;
}[keyof T];

type AllData<T> = { [K in keyof T]-?: IsData<T[K]> }[keyof T];

// Infra can't make handlers for a function from a runtime module, so it
// doesn't see the function's `handle`.
type WithoutHandle<F> = "handle" extends keyof F ? Omit<F, "handle"> : F;

/**
 * How infra sees a runtime module that it imports `with { type: "runtime" }`.
 * Each handler becomes a `RuntimeRef`, an exported function declaration
 * becomes its function, and every other export becomes `RuntimeOnly`. The
 * function has no `handle`.
 */
export type InfraView<M> = {
  readonly [K in keyof M]: M[K] extends {
    readonly "~notation.handler": {
      event: infer E;
      result: infer R;
      function: infer F;
    };
  }
    ? RuntimeRef<E, R, WithoutHandle<F>>
    : M[K] extends { readonly "~notation.function": infer F }
      ? WithoutHandle<F>
      : RuntimeOnly<K>;
};
