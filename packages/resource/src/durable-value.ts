/**
 * A value the reconciler can record: step results, params and stored state.
 * It matches yieldstar's `DurableValue`, so this package does not depend on
 * yieldstar. Arrays are readonly so that `Durable<T>` is assignable to it.
 */
export type DurableValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | bigint
  | Date
  | Error
  | readonly DurableValue[]
  | Map<DurableValue, DurableValue>
  | Set<DurableValue>
  | DurableObject;

export type DurableObject = { [key: string]: DurableValue };

/**
 * Maps `T` to the durable value of the same shape. A function, or a class
 * instance such as a `Buffer` whose methods are functions, maps to `never`.
 * Unlike `DurableObject`, it accepts interfaces. Unlike yieldstar's
 * `Durable`, it keeps mutable arrays mutable, so params still satisfy the SDK
 * types.
 */
export type Durable<T> = T extends
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Date
  | Error
  ? T
  : T extends (infer U)[]
    ? Durable<U>[]
    : T extends readonly (infer U)[]
      ? readonly Durable<U>[]
      : T extends Map<infer K, infer V>
        ? Map<Durable<K>, Durable<V>>
        : T extends ReadonlyMap<infer K, infer V>
          ? ReadonlyMap<Durable<K>, Durable<V>>
          : T extends Set<infer U>
            ? Set<Durable<U>>
            : T extends ReadonlySet<infer U>
              ? ReadonlySet<Durable<U>>
              : T extends Function
                ? never
                : { [K in keyof T]: Durable<T[K]> };
