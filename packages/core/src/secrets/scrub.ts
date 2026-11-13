import { Redacted } from "./redacted";
import { getSecretsState } from "./state";

export const REDACTED_VALUE = "[REDACTED]";

/**
 * Records a raw secret string in the active process so `scrubSecrets` and
 * `scrubError` remove it (along with its base64 and JSON-escaped forms) from
 * error messages and output. Empty strings are ignored.
 */
export function recordSecret(value: string): void {
  if (!value) return;
  getSecretsState().recordedSecrets.add(value);
}

/**
 * Clears all recorded secret strings in the current process. Intended for tests.
 */
export function clearRecordedSecrets(): void {
  getSecretsState().recordedSecrets.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSortedSecretVariants(): string[] {
  const { recordedSecrets } = getSecretsState();
  if (recordedSecrets.size === 0) return [];
  const variants = new Set<string>();
  for (const raw of recordedSecrets) {
    if (!raw) continue;
    variants.add(raw);
    const base64 = Buffer.from(raw, "utf8").toString("base64");
    if (base64) variants.add(base64);
    const jsonEscaped = JSON.stringify(raw).slice(1, -1);
    if (jsonEscaped) variants.add(jsonEscaped);
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every recorded secret value (in raw, base64, and JSON-escaped forms,
 * matched longest-first) with `[REDACTED]`.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  const variants = getSortedSecretVariants();
  if (variants.length === 0) return text;
  const pattern = new RegExp(variants.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, REDACTED_VALUE);
}

/**
 * Recursively scrubs recorded secrets from strings, `Error` instances
 * (preserving prototype, `name`, `stack`, `cause`, `errors`, and enumerable
 * properties without mutating the original error), arrays, and plain objects.
 */
export function scrubError(
  error: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (getSecretsState().recordedSecrets.size === 0) return error;
  if (typeof error === "string") return scrubSecrets(error);
  if (error === null || typeof error !== "object") return error;
  if (Redacted.is(error)) return error;
  if (seen.has(error)) return error;
  seen.add(error);

  if (Array.isArray(error)) {
    return error.map((item) => scrubError(item, seen));
  }

  if (error instanceof Error) {
    const scrubbed = new Error(scrubSecrets(error.message));
    Object.setPrototypeOf(scrubbed, Object.getPrototypeOf(error));
    if (error.name) {
      Object.defineProperty(scrubbed, "name", {
        value: error.name,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (typeof error.stack === "string") {
      Object.defineProperty(scrubbed, "stack", {
        value: scrubSecrets(error.stack),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if ("cause" in error && error.cause !== undefined) {
      Object.defineProperty(scrubbed, "cause", {
        value: scrubError(error.cause, seen),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    let scrubbedErrorsArray = false;
    if (
      "errors" in error &&
      Array.isArray((error as { errors?: unknown }).errors)
    ) {
      scrubbedErrorsArray = true;
      Object.defineProperty(scrubbed, "errors", {
        value: (error as { errors: unknown[] }).errors.map((e) =>
          scrubError(e, seen),
        ),
        writable: true,
        enumerable: Object.prototype.propertyIsEnumerable.call(error, "errors"),
        configurable: true,
      });
    }
    for (const key of Object.keys(error)) {
      if (
        key === "message" ||
        key === "name" ||
        key === "stack" ||
        key === "cause" ||
        (scrubbedErrorsArray && key === "errors")
      ) {
        continue;
      }
      try {
        Object.defineProperty(scrubbed, key, {
          value: scrubError(
            (error as unknown as Record<string, unknown>)[key],
            seen,
          ),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {
        // Skip properties that cannot be redefined.
      }
    }
    return scrubbed;
  }

  const proto = Object.getPrototypeOf(error);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> =
      proto === null ? Object.create(null) : {};
    for (const key of Object.keys(error)) {
      out[key] = scrubError((error as Record<string, unknown>)[key], seen);
    }
    return out;
  }

  return error;
}
