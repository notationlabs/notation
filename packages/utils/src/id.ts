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

// Whether `S` stands for more than one string, such as `string`,
// `${number}` or `${string}-config`. A record keyed by such a type has an
// index signature, so `{}` is assignable to it.
type IsPattern<S extends string> = {} extends Record<S, unknown> ? true : false;

// "literal" when `S` is one name-safe string. "template" when `S` is a
// template literal type, or `string`, whose fixed characters are name-safe.
// Inferring the first character of a template literal type that starts with
// a hole, such as `${string}-config`, gives the whole hole. A hole's
// characters and the length of a template are left to `assertId`.
type CheckNameSafe<
  S extends string,
  Count extends unknown[] = [],
  Template extends boolean = false,
> = S extends `${infer Char}${infer Rest}`
  ? IsPattern<Char> extends true
    ? CheckNameSafe<Rest, Count, true>
    : Char extends NameSafeChar
      ? Template extends true
        ? CheckNameSafe<Rest, Count, true>
        : Count["length"] extends typeof ID_MAX_LENGTH
          ? false
          : CheckNameSafe<Rest, [...Count, unknown], false>
      : false
  : IsPattern<S> extends true
    ? "template"
    : Template extends true
      ? "template"
      : Count extends []
        ? false
        : "literal";

/**
 * Resolves to `S` when `S` can be a name-safe id, and to an error message
 * otherwise:
 * - A string literal, such as `"flags"`, must follow the whole rule: 1 to 64
 *   letters, digits, hyphens or underscores.
 * - A template literal type, such as `${string}-config`, passes when its
 *   fixed parts hold only those characters. Its holes and its length are
 *   checked at runtime, by `assertId`.
 * - Plain `string` passes, and is only checked at runtime.
 */
export type NameSafe<S extends string> = string extends S
  ? S
  : CheckNameSafe<S> extends "literal" | "template"
    ? S
    : IsPattern<S> extends true
      ? `Error: the fixed parts of a template id must be name-safe; use ${typeof ID_RULE}`
      : `Error: "${S}" is not name-safe; use ${typeof ID_RULE}`;

/**
 * The type of an `id` option, checked as `NameSafe` checks it. A function
 * with a type parameter before `Id`, such as the schema of `queue()`,
 * defaults `Id` to `never`. A call that passes that type explicitly can't
 * infer `Id`, so the id is then typed as `string` and only checked at
 * runtime.
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
