export type IfAllPropertiesOptional<T, Y, N> =
  T extends Partial<T> ? (Partial<T> extends T ? Y : N) : N;

/**
 * @typeParam K - The record key
 * @typeParam T - The record value type
 * @description If T is Partial<T>, return { [key in K]?: T }, else return { [key in K]: T }
 */
export type OptionalIfAllPropertiesOptional<
  K extends string,
  T,
> = IfAllPropertiesOptional<T, { [key in K]?: T }, { [key in K]: T }>;

/**
 * Extracts the keys from type `T` that are required.
 * A key is considered required if it is present in `Required<T>`.
 *
 * @typeParam T - The type to extract required keys from.
 *
 * @returns A union of the keys of `T` that are required.
 */
export type RequiredKeys<T> = {
  [K in keyof T]-?: T[K] extends Required<T>[K] ? K : never;
}[keyof T];

/**
 * Creates a tuple type consisting of each required key of type `T` as a separate element.
 * This type maps over each key in `T`, including it in the tuple if it is required.
 * If `T` has no required keys, an empty tuple type is returned.
 *
 * @typeParam T - The type to create a tuple of required keys from.
 *
 * @returns A tuple type with each required key of `T` as a separate element, or an empty tuple if `T` has no required keys.
 */
export type RequiredKeysTuple<T> = keyof T extends infer D
  ? D extends keyof T
    ? T[D] extends Required<T>[D]
      ? [D, ...RequiredKeysTuple<Omit<T, D>>]
      : RequiredKeysTuple<Omit<T, D>>
    : never
  : [];

/**
 * Provides a fallback value if the first type is `undefined`.
 * If the first type `T` is `undefined`, the fallback type `U` is used instead.
 *
 * @typeParam T - The first type.
 * @typeParam U - The fallback type.
 */
export type Fallback<T, U> = T extends undefined ? U : T;

/**
 * Provides a fallback if `T` is assignable to `C`.
 */
export type FallbackIf<T, C, U> = C extends T ? U : T;

/**
 * A utility type that prevents inference of a generic type parameter.
 * This is useful when you want to preserve the exact type passed as an argument.
 *
 * @typeParam T - The type to prevent inference for.
 * @returns T.
 *
 * @example
 * ```typescript
 * function foo<T>(arg: NoInfer<T>): void {
 *   // ...
 * }
 *
 * const value: string = "Hello";
 * foo(value); // Argument type is preserved as string
 * ```
 */
export type NoInfer<T> = [T][T extends any ? 0 : never];
