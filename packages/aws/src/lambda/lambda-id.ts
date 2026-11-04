/**
 * Lambda IDs are name-safe: 1 to 64 ASCII letters, digits, hyphens and
 * underscores.
 *
 * The ID is embedded in resource IDs (`<id>`, `<id>-role`, `<id>-zip`,
 * `<id>-policy`, `<id>-role-policy`, `<id>-log-group`) and in AWS names, so
 * its characters have to be valid in all of them:
 *
 * - Lambda `FunctionName` (`<app>--<stage>--<id>`): `[a-zA-Z0-9-_]`.
 * - IAM `RoleName` (`<app>--<stage>--<id>-role`): `[\w+=,.@-]`.
 * - The EventBridge target `Id` is the function name: `[.\-_A-Za-z0-9]`.
 * - Lambda permission `StatementId`s embed the function name: `[0-9A-Za-z_-]`.
 *
 * The limit of 64 is the Lambda `FunctionName` limit. The function and role
 * names add the app and stage, and are shortened with a hash when they pass
 * 64 characters (see `src/naming.ts`). The inline policy name
 * (`<id>-role-policy`) allows 128.
 *
 * Upper case is allowed because Lambda allows it. IAM role names are unique
 * regardless of case, so two IDs that differ only in case count as
 * duplicates.
 */
export const LAMBDA_ID_MAX_LENGTH = 64;

const LAMBDA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const RULE =
  `1 to ${LAMBDA_ID_MAX_LENGTH} letters (A-Z, a-z), digits, hyphens or underscores` as const;

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
    ? Count["length"] extends typeof LAMBDA_ID_MAX_LENGTH
      ? false
      : IsNameSafe<Rest, [...Count, unknown]>
    : false
  : Count extends []
    ? false
    : true;

/**
 * Resolves to `S` when `S` is a name-safe string literal, and to an error
 * message when it is a literal that isn't. A string that isn't a literal,
 * such as an ID built from infra, is typed `string` or a template such as
 * `${string}-checkout`. Its contents can't be checked in types, so it
 * resolves to `S`, and `lambda()` checks it when it runs.
 */
export type NameSafe<S extends string> =
  {} extends Record<S, unknown>
    ? S
    : IsNameSafe<S> extends true
      ? S
      : `Error: "${S}" is not name-safe; use ${typeof RULE}`;

export function isNameSafe(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= LAMBDA_ID_MAX_LENGTH &&
    LAMBDA_ID_PATTERN.test(id)
  );
}

export function assertLambdaId(id: unknown): asserts id is string {
  if (id === undefined || id === null || id === "") {
    throw new Error(
      `lambda() requires an id: ${RULE}. The id names the function and its role, zip, policy and log group, so keep it stable.`,
    );
  }
  if (!isNameSafe(id)) {
    throw new Error(`Invalid lambda id ${JSON.stringify(id)}: use ${RULE}.`);
  }
}
