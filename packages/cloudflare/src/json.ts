import type { StandardSchemaV1 } from "@notation/resource";
import { sortedJson } from "@notation/utils";

// The runtime build of a Worker loads the declarations, which import `Json`
// from this module as a type only.

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

type Issue = { message: string; path: string[] };

// The largest value that Workers KV stores.
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * A validator of JSON values that `JSON.stringify` writes as they are. It
 * fails a value that `JSON.stringify` would change or drop, such as `NaN`,
 * a `Date`, a sparse array, or `undefined` at any depth. It also fails an
 * object key named `__proto__`, and a value whose text from
 * `sortedJson.encode` is longer than 25 MiB in UTF-8.
 */
export function jsonSchema(): StandardSchemaV1<Json, Json> {
  return {
    "~standard": {
      version: 1,
      vendor: "notation",
      validate(value) {
        const issues: Issue[] = [];
        collectIssues(value, [], issues);
        if (issues.length === 0) {
          const bytes = new TextEncoder().encode(
            sortedJson.encode(value),
          ).length;
          if (bytes > MAX_BYTES) {
            issues.push({
              message: `The JSON text is ${bytes} bytes, more than the limit of ${MAX_BYTES}`,
              path: [],
            });
          }
        }
        return issues.length > 0 ? { issues } : { value: value as Json };
      },
    },
  };
}

function collectIssues(value: unknown, path: string[], issues: Issue[]): void {
  const fail = (message: string) => issues.push({ message, path });
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        fail(`${value} isn't JSON. JSON.stringify writes it as null`);
      }
      return;
    case "undefined":
      fail("undefined isn't JSON. Leave the key out instead");
      return;
    case "object":
      break;
    default:
      fail(`A ${typeof value} isn't JSON`);
      return;
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const entryPath = [...path, String(index)];
      if (!(index in value)) {
        issues.push({
          message:
            "A sparse array isn't JSON. JSON.stringify writes each hole as null",
          path: entryPath,
        });
        continue;
      }
      if (value[index] === undefined) {
        issues.push({
          message:
            "undefined isn't JSON. JSON.stringify writes it as null in an array",
          path: entryPath,
        });
        continue;
      }
      collectIssues(value[index], entryPath, issues);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = prototype?.constructor?.name ?? "object";
      fail(`A ${name} isn't JSON. Only plain objects are`);
    } else {
      for (const [key, entry] of Object.entries(value)) {
        // An assignment to `__proto__` sets the prototype, so the encoder and
        // the merge of contributions would lose the key.
        if (key === "__proto__") {
          issues.push({
            message: "The key __proto__ isn't supported. Use another key",
            path: [...path, key],
          });
          continue;
        }
        collectIssues(entry, [...path, key], issues);
      }
    }
  }
}
