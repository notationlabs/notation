export type IfAllPropertiesOptional<T, Y, N> =
  T extends Partial<T> ? (Partial<T> extends T ? Y : N) : N;

export type OptionalIfAllPropertiesOptional<
  K extends string,
  T,
> = IfAllPropertiesOptional<T, { [Key in K]?: T }, { [Key in K]: T }>;

export type Fallback<T, U> = T extends undefined ? U : T;

export type NoInfer<T> = [T][T extends any ? 0 : never];

/**
 * Flattens an intersection into a single object type.
 *
 * Keeps mapped types readable in IntelliSense without the assignability
 * checks a conditional-based unwrap would cost.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Deeply makes all properties optional. The items of an array in a property
 * stay required, as an `undefined` item stays in a merged list.
 */
export type DeepPartial<T> = {
  [P in keyof T]?: DeepPartialValue<T[P]>;
};

/**
 * `DeepPartial` of an object, and an array of `DeepPartialValue` of its
 * items.
 */
// An array is written as an array type, which the type checker expands only
// when it is read, so a recursive type such as a JSON value ends.
export type DeepPartialValue<T> = T extends readonly (infer E)[]
  ? T extends unknown[]
    ? DeepPartialValue<E>[]
    : readonly DeepPartialValue<E>[]
  : T extends object
    ? DeepPartial<T>
    : T;

type OptionalKeys<T> = {
  [K in keyof T]: undefined extends T[K] ? never : K;
}[keyof T];

/**
 * Pick the required (non-optional) keys from T.
 */
export type OmitOptional<T> = Pick<T, OptionalKeys<T>>;

/**
 * Pick the optional keys from T.
 */
export type PickOptional<T> = Omit<T, OptionalKeys<T>>;
