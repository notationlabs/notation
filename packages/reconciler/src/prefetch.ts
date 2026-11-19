import {
  containsUnknownAfterApply,
  isCredentialSource,
  type BaseCredentialSource,
  type BaseResource,
  type PrefetchedSource,
  type RecordedOutputs,
  type ResourceType,
  validateParams,
} from "@notation/resource";
import { scrubError, scrubSecretValues } from "@notation/utils";
import type { ReconcilerEventEmitter } from "./events";
import { getDependencyIds } from "./plan";

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

/**
 * What `read` or `loadCredential` of `source` gets as `context.prefetched`.
 * A source that `canPrefetch` rejects gets nothing.
 */
export function prefetchedFor(
  prefetched: PrefetchedValues,
  source: BaseCredentialSource,
): { prefetched?: unknown } {
  if (!canPrefetch(source) || !prefetched.has(source.prefetch)) return {};
  return { prefetched: prefetched.get(source.prefetch) };
}

/**
 * Whether `prefetchSources` can pass `resource` to its class's `prefetch`:
 * it is a source whose class has a `prefetch`, and it depends on no other
 * resource. `prefetchSources` also leaves out a source whose params are not
 * known.
 */
export function canPrefetch(
  resource: BaseResource,
): resource is BaseCredentialSource & { prefetch: PrefetchFunction } {
  return (
    isCredentialSource(resource) &&
    resource.prefetch !== undefined &&
    getDependencyIds(resource).length === 0
  );
}

/**
 * Calls the `prefetch` of each class of source once, with every source of
 * the class that depends on no other resource and whose params are known.
 * Each source that is left out is fetched by its own `read`. Throws one
 * `SourcePrefetchError` with every source that a `prefetch` returned in
 * `failed`. A `prefetch` that throws stops the calls of the classes after
 * it, and the failures from the classes before it are dropped.
 *
 * A source that depends on another resource is left out, because plan and
 * deploy can replace that resource, and the params built from its old
 * outputs can name a value that the source no longer has.
 */
export async function prefetchSources({
  resources,
  recordedOutputs,
  point,
  executionId,
  app,
  stage,
  emit,
}: {
  resources: BaseResource[];
  recordedOutputs: RecordedOutputs;
  point: "plan" | "deploy";
  executionId: string;
  app: string;
  stage: string;
  emit?: ReconcilerEventEmitter;
}): Promise<PrefetchedValues> {
  const prefetched = new Map<PrefetchFunction, unknown>();
  const groups = new Map<
    PrefetchFunction,
    { type: ResourceType; sources: PrefetchedSource[] }
  >();
  for (const resource of resources.filter(canPrefetch)) {
    // A `~state` ref resolves through `recordedOutputs`, and is unknown when
    // its target has no record.
    const params = await resource.planParams({ recordedOutputs });
    if (containsUnknownAfterApply(params)) continue;
    await validateParams(resource, params, point);
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
          try {
            void Promise.resolve(
              emit?.({
                level: "info",
                event: "reconciler.source.notice",
                resourceType: group.type,
                message,
              }),
            ).catch(() => {});
          } catch {}
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
