import type * as cf from "@cloudflare/workers-types";
import type { StandardSchemaV1 } from "@notation/resource";

// The runtime build also loads this module, so it must only import types.

/** Thrown by `readKVJson()` when the stored text is not JSON or fails the schema. */
export class KVJsonError extends Error {
  readonly key: string;
  /** The schema's issues. Empty when the stored text is not JSON. */
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(
    message: string,
    key: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue> = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KVJsonError";
    this.key = key;
    this.issues = issues;
  }
}

/**
 * Reads the JSON document in `key`, such as one from `kvJson()`, validates it
 * with `schema`, and returns the schema's output. Returns `undefined` when
 * the namespace has no such key, which can happen for about 60 seconds after
 * the first deploy writes it. Throws `KVJsonError` when the stored text is not
 * JSON or fails the schema. Import the schema from the shared module that the
 * infra imports it from.
 */
export async function readKVJson<S extends StandardSchemaV1>(
  namespace: Pick<cf.KVNamespace, "get">,
  key: string,
  schema: S,
  // Passed to `get`, such as `cacheTtl`.
  options?: Omit<cf.KVNamespaceGetOptions<"text">, "type">,
): Promise<StandardSchemaV1.InferOutput<S> | undefined> {
  const text = await namespace.get(key, { ...options, type: "text" });
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new KVJsonError(
      `The value of the KV key ${JSON.stringify(key)} is not JSON.`,
      key,
      [],
      { cause: error },
    );
  }
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const issues = result.issues.map(formatIssue).join("; ");
    throw new KVJsonError(
      `The value of the KV key ${JSON.stringify(key)} does not match the schema: ${issues}`,
      key,
      result.issues,
    );
  }
  return result.value as StandardSchemaV1.InferOutput<S>;
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? [])
    .map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    )
    .join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
