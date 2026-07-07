export type IfAllPropertiesOptional<T, Y, N> = T extends Partial<T>
  ? Partial<T> extends T
    ? Y
    : N
  : N;

export type OptionalIfAllPropertiesOptional<K extends string, T> =
  IfAllPropertiesOptional<T, { [Key in K]?: T }, { [Key in K]: T }>;

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
 * Deeply makes all properties optional.
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

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
