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
  | Error
  | readonly DurableValue[]
  | DurableObject;

export type DurableObject = { [key: string]: DurableValue };

/**
 * Maps `T` to the durable value of the same shape. A property that cannot be
 * recorded, such as a `Date` or a `Buffer`, maps to `never`. Unlike
 * `DurableObject`, it accepts interfaces. Unlike yieldstar's `Durable`, it
 * keeps mutable arrays mutable, so params still satisfy the SDK types.
 */
export type Durable<T> = T extends
  string | number | boolean | null | undefined | Error
  ? T
  : T extends (infer U)[]
    ? Durable<U>[]
    : T extends readonly (infer U)[]
      ? readonly Durable<U>[]
      : T extends Function | Date | Map<any, any> | Set<any> | bigint
        ? never
        : { [K in keyof T]: Durable<T[K]> };
