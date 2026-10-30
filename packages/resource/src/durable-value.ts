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
export type Durable<T> = DurableWith<T, never>;

/** `T` as `toDurable` returns it: each `Date` is an ISO 8601 string. */
export type ToDurable<T> = DurableWith<T, string>;

/** A value that `toDurable` turns into a durable value. */
export type Encodable<T> = DurableWith<T, Date>;

type DurableWith<T, D> = T extends
  string | number | boolean | null | undefined | Error
  ? T
  : T extends Date
    ? D
    : T extends (infer U)[]
      ? DurableWith<U, D>[]
      : T extends readonly (infer U)[]
        ? readonly DurableWith<U, D>[]
        : T extends Function | Map<any, any> | Set<any> | bigint
          ? never
          : { [K in keyof T]: DurableWith<T[K], D> };

/**
 * Copies `value` with each `Date` replaced by its ISO 8601 string. Other
 * values are copied as they are, and the reconciler rejects any that are not
 * durable when it records them.
 */
export function toDurable<T>(value: T): ToDurable<T> {
  if (value instanceof Date) return value.toISOString() as ToDurable<T>;
  if (Array.isArray(value)) return value.map(toDurable) as ToDurable<T>;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = toDurable(item);
    }
    return copy as ToDurable<T>;
  }
  return value as ToDurable<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
