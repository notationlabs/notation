import {
  containsUnknownAfterApply,
  isCredentialSource,
  type BaseCredentialSource,
  type BaseResource,
  type PrefetchedSource,
  type RecordedOutputs,
  type ResourceType,
} from "@notation/resource";
import type { StateNode } from "@notation/state";
import { scrubError, scrubSecretValues } from "@notation/utils";
import type { ReconcilerEventEmitter } from "./events";
import { loadOutput, planKnownParams } from "./planner";

type PrefetchFunction = NonNullable<BaseCredentialSource["prefetch"]>;

/**
 * What each class's `prefetch` returned, by its `prefetch` function. A plan
 * or deploy keeps it in memory until it ends.
 */
export type PrefetchedValues = ReadonlyMap<PrefetchFunction, unknown>;

export type FailedSource = {
  id: string;
  type: ResourceType;
  message: string;
};

/** Sources that their class's `prefetch` could not fetch. */
export class SourcePrefetchError extends Error {
  readonly _tag = "SourcePrefetchError" as const;
  readonly failed: readonly FailedSource[];

  constructor(failed: readonly FailedSource[]) {
    super(
      [
        failed.length === 1
          ? "1 source could not be fetched."
          : `${failed.length} sources could not be fetched.`,
        ...failed.map(
          (source) => `  ${source.id} (${source.type}): ${source.message}`,
        ),
      ].join("\n"),
    );
    this.name = "SourcePrefetchError";
    this.failed = failed;
  }

  static is(error: unknown): error is SourcePrefetchError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { _tag?: unknown })._tag === "SourcePrefetchError"
    );
  }
}

/** What `read` or `loadCredential` of `source` gets as `context.prefetched`. */
export function prefetchedFor(
  prefetched: PrefetchedValues,
  source: BaseCredentialSource,
): { prefetched?: unknown } {
  if (!source.prefetch || !prefetched.has(source.prefetch)) return {};
  return { prefetched: prefetched.get(source.prefetch) };
}

/**
 * Calls the `prefetch` of each class of source once, with every source of
 * the class whose params are known. A source whose params hold an output
 * that is not deployed yet is left out. Throws one `SourcePrefetchError`
 * with every source that a `prefetch` returned in `failed`. A `prefetch`
 * that throws stops the calls of the classes after it.
 *
 * The params are planned from the outputs in state, as `validateKnownParams`
 * plans them. The outputs are left loaded. This is safe because plan and
 * deploy load each resource's output from state again before they plan or
 * reconcile it, and they reach a resource's dependencies before it.
 */
export async function prefetchSources({
  resources,
  state,
  recordedOutputs,
  point,
  executionId,
  app,
  stage,
  emit,
}: {
  resources: BaseResource[];
  state: { get(id: string): Promise<StateNode | undefined> };
  recordedOutputs: RecordedOutputs;
  point: "plan" | "deploy";
  executionId: string;
  app: string;
  stage: string;
  emit?: ReconcilerEventEmitter;
}): Promise<PrefetchedValues> {
  const prefetched = new Map<PrefetchFunction, unknown>();
  const hasPrefetch = (
    resource: BaseResource,
  ): resource is BaseCredentialSource & { prefetch: PrefetchFunction } =>
    isCredentialSource(resource) && resource.prefetch !== undefined;
  if (!resources.some(hasPrefetch)) return prefetched;

  for (const resource of resources) await loadOutput(resource, state);
  const groups = new Map<
    PrefetchFunction,
    { type: ResourceType; sources: PrefetchedSource[] }
  >();
  for (const resource of resources.filter(hasPrefetch)) {
    const { params } = await planKnownParams(
      resource,
      state,
      point,
      recordedOutputs,
    );
    if (containsUnknownAfterApply(params)) continue;
    const group = groups.get(resource.prefetch) ?? {
      type: resource.type,
      sources: [],
    };
    group.sources.push({ id: resource.id, params });
    groups.set(resource.prefetch, group);
  }

  const failed: FailedSource[] = [];
  for (const [prefetch, group] of groups) {
    let result;
    try {
      result = await prefetch(group.sources, {
        executionId,
        app,
        stage,
        // Not awaited: the emitters write the event before they return. A
        // notice that fails to show must not fail the plan or deploy.
        notify: (message) => {
          void Promise.resolve()
            .then(() =>
              emit?.({
                level: "info",
                event: "reconciler.source.notice",
                resourceType: group.type,
                message,
              }),
            )
            .catch(() => {});
        },
      });
    } catch (error) {
      throw scrubError(error);
    }
    prefetched.set(prefetch, result.prefetched);
    for (const { id, error } of result.failed) {
      failed.push({ id, type: group.type, message: scrubbedMessage(error) });
    }
  }
  if (failed.length > 0) throw new SourcePrefetchError(failed);
  return prefetched;
}

function scrubbedMessage(error: unknown): string {
  return scrubSecretValues(
    error instanceof Error ? error.message : String(error),
  );
}
