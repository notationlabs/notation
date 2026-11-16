// The longest id. AWS also uses it as the longest JWT authorizer name.
export const ID_MAX_LENGTH = 64;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The rule that a name-safe id follows, for error messages. */
export const ID_RULE =
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
  ? `Error: the id must be a string literal of ${typeof ID_RULE}`
  : IsNameSafe<S> extends true
    ? S
    : `Error: "${S}" is not name-safe; use ${typeof ID_RULE}`;

/**
 * The type of an `id` option. A function with a type parameter before `Id`,
 * such as the schema of `queue()`, defaults `Id` to `never`. A call that
 * passes that type explicitly can't infer `Id`, so the id is then typed as
 * `string` and only checked at runtime.
 */
export type IdOption<Id extends string> = [Id] extends [never]
  ? string
  : NameSafe<Id>;

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
      `${caller} requires an id: ${ID_RULE}. The id keys the resource in state, and deploy can build names from it, so keep it stable.`,
    );
  }
  if (!isNameSafe(id)) {
    throw new Error(
      `Invalid ${caller} id ${JSON.stringify(id)}: use ${ID_RULE}.`,
    );
  }
}
