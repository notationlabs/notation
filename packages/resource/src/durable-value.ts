/**
 * A value the reconciler can record: step results, params and stored state.
 * It matches yieldstar's `DurableValue`, so this package does not depend on
 * yieldstar.
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
  | ReadonlyMap<DurableValue, DurableValue>
  | ReadonlySet<DurableValue>
  | DurableObject;

export type DurableObject = { [key: string]: DurableValue };

/**
 * Maps `T` to the durable value of the same shape. A function, or a class
 * instance such as a `Buffer` whose methods are functions, maps to `never`.
 * Unlike `DurableObject`, it accepts interfaces.
 */
export type Durable<T> = T extends
  string | number | boolean | null | undefined | bigint | Date | Error
  ? T
  : T extends readonly (infer U)[]
    ? // Only tuples go through the mapped type. On a recursive array type such
      // as `DurableValue[]` it exceeds TypeScript's instantiation depth.
      number extends T["length"]
      ? T extends unknown[]
        ? Durable<U>[]
        : readonly Durable<U>[]
      : { [K in keyof T]: Durable<T[K]> }
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
