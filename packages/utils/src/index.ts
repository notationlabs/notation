export function isErrorWithCode(
  error: unknown,
  code: string,
): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export { sortedJson } from "./sorted-json";
export {
  SCRUBBED,
  clearSecretValues,
  recordSecretValue,
  scrubError,
  scrubSecretValues,
} from "./secret-values";
export {
  assertId,
  ID_MAX_LENGTH,
  ID_RULE,
  isNameSafe,
  type IdOption,
  type NameSafe,
} from "./id";
