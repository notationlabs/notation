// The values are kept on globalThis, so that every copy of this package in
// the process scrubs the same values.
const registryKey = Symbol.for("@notation/utils/secret-values");

type Registry = { values: Set<string>; patterns: string[] | undefined };

function registry(): Registry {
  const holder = globalThis as { [registryKey]?: Registry };
  holder[registryKey] ??= { values: new Set(), patterns: undefined };
  return holder[registryKey];
}

export const SCRUBBED = "<hidden>";

/**
 * Records a secret's value, so that `scrubSecretValues` removes it from text
 * for the rest of the process. It records the raw value, its base64 form and
 * its JSON-escaped form, as a provider can echo any of them back in an error.
 */
export function recordSecretValue(value: string): void {
  if (value === "") return;
  const { values } = registry();
  const forms = [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    JSON.stringify(value).slice(1, -1),
  ];
  for (const form of forms) {
    if (form !== "" && !values.has(form)) {
      values.add(form);
      registry().patterns = undefined;
    }
  }
}

/** Replaces each recorded secret value in `text` with `<hidden>`. */
export function scrubSecretValues(text: string): string {
  const state = registry();
  if (state.values.size === 0) return text;
  // Longest first, so that a value that contains another is replaced whole.
  state.patterns ??= [...state.values].sort((a, b) => b.length - a.length);
  let scrubbed = text;
  for (const pattern of state.patterns) {
    if (scrubbed.includes(pattern)) {
      scrubbed = scrubbed.split(pattern).join(SCRUBBED);
    }
  }
  return scrubbed;
}

/**
 * Removes recorded secret values from an error's message and stack, and from
 * the errors it holds in `cause` and `errors`. It changes the error in place
 * and returns it, so that the error keeps its class.
 */
export function scrubError<T>(error: T): T {
  if (registry().values.size === 0) return error;
  scrubErrorIn(error, new Set());
  return error;
}

function scrubErrorIn(error: unknown, seen: Set<unknown>): void {
  if (typeof error !== "object" || error === null || seen.has(error)) return;
  seen.add(error);
  const fields = error as Record<string, unknown>;
  for (const key of ["message", "stack"]) {
    const value = fields[key];
    if (typeof value !== "string") continue;
    const scrubbed = scrubSecretValues(value);
    if (scrubbed === value) continue;
    try {
      fields[key] = scrubbed;
    } catch {
      // A read-only field is left as it is.
    }
  }
  scrubErrorIn(fields.cause, seen);
  if (Array.isArray(fields.errors)) {
    for (const inner of fields.errors) scrubErrorIn(inner, seen);
  }
}

/** Forgets every recorded value. For tests. */
export function clearSecretValues(): void {
  registry().values.clear();
  registry().patterns = undefined;
}
