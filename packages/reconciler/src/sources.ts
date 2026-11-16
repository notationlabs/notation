import { isDeepStrictEqual } from "node:util";
import {
  credentialMarker,
  credentialNames,
  diffParams,
  validateValues,
  type BaseCredentialSource,
  type CredentialSourceContext,
  type ParamsDiffDisplay,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { sourceCredentialVersion, withoutCredentials } from "./credentials";

export type SourceDecision = "create" | "update" | "noop";

export type SourceRead = {
  /** The outputs that `read` returned, which the schema declares. */
  result: Record<string, unknown>;
  /** The messages that `read` passed to `warn`. */
  warnings: string[];
};

/**
 * The outputs in the source's record without its credential, as its
 * operations receive them. Undefined without a record.
 */
export function sourceState(
  source: BaseCredentialSource,
  output: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!output) return undefined;
  return source.toState(withoutCredentials(source, output));
}

/** Calls the source's `read`, and checks what it returns. */
export async function readSource(
  source: BaseCredentialSource,
  params: Record<string, unknown>,
  context: CredentialSourceContext,
  record: StateNode | undefined,
): Promise<SourceRead> {
  const warnings: string[] = [];
  const recorded = record && !isCreatingRecord(record) ? record : undefined;
  const returned = await source.readSource(params, {
    ...context,
    state: sourceState(source, recorded?.output),
    warn: (message) => warnings.push(message),
  });
  const result = withoutCredentials(source, source.toResult(returned ?? {}));
  await validateValues(source, result, "read");
  if (result.revision === undefined) {
    throw new Error(
      `The read of ${source.id} (${source.type}) returned no revision`,
    );
  }
  return { result, warnings };
}

/**
 * Decides what deploy does with a source, from its record and a read. The
 * source is created when it has no record, and updated when a param or a
 * computed output differs from the record. It is never replaced. `output`
 * holds a marker for each credential, with the version that the params and
 * the revision make.
 */
export function decideSource(
  source: BaseCredentialSource,
  record: StateNode | undefined,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
): {
  decision: SourceDecision;
  output: Record<string, unknown>;
  diff?: ParamsDiffDisplay;
} {
  const output: Record<string, unknown> = { ...params, ...result };
  for (const name of credentialNames(source.schema)) {
    output[name] = credentialMarker(
      source.id,
      name,
      sourceCredentialVersion(source, name, params, result.revision),
    );
  }
  if (!record || isCreatingRecord(record)) {
    return { decision: "create", output };
  }

  const { patch, diff } = diffParams(source.schema, record.params, params, {
    canUpdate: true,
  });
  for (const [key, value] of Object.entries(result)) {
    const previous = record.output[key];
    if (isDeepStrictEqual(previous, value)) continue;
    if (previous === undefined) diff.added[key] = value;
    else diff.updated[key] = value;
    patch[key] = value;
  }
  const decision = Object.keys(patch).length > 0 ? "update" : "noop";
  return { decision, output, ...(decision === "update" ? { diff } : {}) };
}
