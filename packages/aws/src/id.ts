// The longest id or name: the length limit of a Lambda FunctionName.
export const ID_MAX_LENGTH = 64;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const RULE =
  `1 to ${ID_MAX_LENGTH} letters (A-Z, a-z), digits, hyphens or underscores` as const;

type Letter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type NameSafeChar = Letter | Uppercase<Letter> | Digit | "-" | "_";

type IsNameSafe<
  S extends string,
  Count extends unknown[] = [],
> = S extends `${infer Char}${infer Rest}`
  ? Char extends NameSafeChar
    ? Count["length"] extends typeof ID_MAX_LENGTH
      ? false
      : IsNameSafe<Rest, [...Count, unknown]>
    : false
  : Count extends []
    ? false
    : true;

/**
 * Resolves to `S` when `S` is a name-safe string literal, and to an error
 * message otherwise. A value typed as plain `string` is rejected, since its
 * contents can't be checked.
 */
export type NameSafe<S extends string> = string extends S
  ? `Error: the id must be a string literal of ${typeof RULE}`
  : IsNameSafe<S> extends true
    ? S
    : `Error: "${S}" is not name-safe; use ${typeof RULE}`;

export function isNameSafe(id: unknown): id is string {
  return (
    typeof id === "string" && id.length <= ID_MAX_LENGTH && ID_PATTERN.test(id)
  );
}

/**
 * Throws when `id` is missing or not name-safe. `caller` names the function
 * that declares the resource, such as `queue()`, in the error.
 */
export function assertId(caller: string, id: unknown): asserts id is string {
  if (id === undefined || id === null || id === "") {
    throw new Error(
      `${caller} requires an id: ${RULE}. The id keys the resource in state and is the default base of its AWS name, so keep it stable.`,
    );
  }
  if (!isNameSafe(id)) {
    throw new Error(`Invalid ${caller} id ${JSON.stringify(id)}: use ${RULE}.`);
  }
}

/**
 * Throws when `name`, the override of a resource's AWS name, is set and is
 * not name-safe.
 */
export function assertName(caller: string, name: unknown): void {
  if (name === undefined) return;
  if (!isNameSafe(name)) {
    throw new Error(
      `Invalid ${caller} name ${JSON.stringify(name)}: use ${RULE}.`,
    );
  }
}
