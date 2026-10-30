/**
 * JSON with the keys of every object sorted, so equal maps always encode to
 * the same string. Arrays keep their order. Like `JSON.stringify`, it drops
 * an `undefined` property and calls `toJSON`.
 */
export const sortedJson = {
  encode(value: unknown): string {
    return JSON.stringify(value, (_key, entry) => sortKeys(entry)) ?? "null";
  },
  decode(text: string): unknown {
    return JSON.parse(text);
  },
};

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return sorted;
}
