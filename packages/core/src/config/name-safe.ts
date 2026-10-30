type CharsOf<S extends string> = S extends `${infer C}${infer Rest}`
  ? C | CharsOf<Rest>
  : never;
type NameChar = CharsOf<"abcdefghijklmnopqrstuvwxyz0123456789-">;

export const maxNameLength = 32;

// Counts characters in N, so a name longer than maxNameLength fails.
type AllNameChars<S extends string, N extends unknown[] = []> = S extends ""
  ? true
  : N["length"] extends typeof maxNameLength
    ? false
    : S extends `${infer C}${infer Rest}`
      ? C extends NameChar
        ? AllNameChars<Rest, [...N, unknown]>
        : false
      : false;

export type IsNameSafe<S extends string> = S extends ""
  ? false
  : S extends `-${string}` | `${string}-`
    ? false
    : AllNameChars<S>;

/**
 * `S` when it is a name-safe string literal: `[a-z0-9-]`, 1 to 32 characters,
 * with no leading or trailing hyphen. Otherwise a message type that `S` is not
 * assignable to. A widened `string` is rejected.
 */
export type NameSafe<S extends string> = string extends S
  ? "a name must be a string literal"
  : IsNameSafe<S> extends true
    ? S
    : `"${S}" is not name-safe`;

const nameSafeRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isNameSafe(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxNameLength &&
    nameSafeRe.test(value)
  );
}

/**
 * Throws when `value` is not name-safe.
 * @param label What the value names, e.g. `stage`, for the error message.
 */
export function assertNameSafe(
  value: unknown,
  label: string,
): asserts value is string {
  if (isNameSafe(value)) return;
  throw new Error(
    `${label} ${JSON.stringify(value)} is not name-safe: use 1 to ${maxNameLength} characters from a-z, 0-9 and "-", with no leading or trailing "-"`,
  );
}
