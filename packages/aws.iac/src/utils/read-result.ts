import type { Schema } from "@notation/resource";

/**
 * Copies the properties of an SDK response that the schema declares. The
 * reconciler records each read result, and a response also holds `$metadata`
 * and undeclared fields, some of which are dates that cannot be recorded.
 */
export function pickDeclared<S extends Schema, T extends object>(
  schema: S,
  response: T,
): Pick<T, Extract<keyof S, keyof T>> {
  const declared = {} as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (key in response) declared[key] = (response as any)[key];
  }
  return declared as Pick<T, Extract<keyof S, keyof T>>;
}
