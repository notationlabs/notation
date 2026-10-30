/**
 * Lambda IDs are name-safe: 1 to 59 ASCII letters, digits, hyphens and
 * underscores.
 *
 * The ID is embedded in resource IDs (`<id>`, `<id>-role`, `<id>-zip`,
 * `<id>-policy`, `<id>-role-policy`, `<id>-log-group`) and in AWS names, so
 * it has to satisfy the strictest of them:
 *
 * - Lambda `FunctionName` is the ID itself: `[a-zA-Z0-9-_]`, at most 64 chars.
 * - IAM `RoleName` is `<id>-role`: at most 64 chars, so the ID gets 59.
 * - The EventBridge target `Id` is the function name: `[.\-_A-Za-z0-9]`.
 * - Lambda permission `StatementId`s embed the function name: `[0-9A-Za-z_-]`.
 *
 * The role name is the tightest length limit. The other suffixes (`-zip`,
 * `-policy`, `-log-group`) and the API Gateway integration and permission IDs
 * only appear in resource IDs, which have no length limit, and the other AWS
 * names have room to spare: the EventBridge permission `StatementId`
 * (`LambdaEventBridgeRulePermission-<id>`) allows 100 chars, the inline
 * policy name (`<id>-role-policy`) 128 and the log group name
 * (`/aws/lambda/<id>`) 512.
 *
 * Upper case is allowed because Lambda allows it, and because compiled IDs
 * (`<module id>-<handler>`) contain camelCase handler names. IAM role names
 * are unique regardless of case, so two IDs that differ only in case count as
 * duplicates.
 */
export const LAMBDA_ID_MAX_LENGTH = 59; // 64 - "-role".length

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
