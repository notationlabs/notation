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
