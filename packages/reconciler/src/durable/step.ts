import type {
  EmitStep,
  ReconcilerEvent,
  ReconcilerEventEmitter,
} from "../events";
import type { DurableStep, WorkflowStore } from "./yieldstar";

/**
 * Namespaces the step keys of `step` so an operation can be written once and
 * replayed at several call sites without its keys colliding.
 *
 * Opening a store is not prefixed: yieldstar derives that key from the store
 * name and store id, which is already unique. The keys the store *handle*
 * takes are caller-supplied, so those are scoped like any other step.
 */
export function scopeStep(step: DurableStep, prefix: string): DurableStep {
  const scoped = (key: string) => `${prefix}:${key}`;

  return {
    ...step,
    // The keyless overloads fall through untouched; yieldstar hashes the call
    // site for those, and a prefix would not make them any more unique.
    run: ((arg1: unknown, arg2?: unknown) =>
      typeof arg1 === "string"
        ? (step.run as any)(scoped(arg1), arg2)
        : (step.run as any)(arg1)) as DurableStep["run"],
    delay: ((arg1: unknown, arg2?: unknown) =>
      typeof arg1 === "string"
        ? (step.delay as any)(scoped(arg1), arg2)
        : (step.delay as any)(arg1)) as DurableStep["delay"],
    store: ((definition: any, params: any) =>
      (async function* () {
        const store = yield* step.store(definition, params);
        return scopeStore(store, prefix);
      })()) as DurableStep["store"],
  };
}

/**
 * Checkpoints delivery so that replaying a workflow does not re-emit. The key
 * is derived from the event itself, which keeps it deterministic across a
 * replay; the enclosing scope is what keeps it unique, since an operation
 * emits each (operation, status) pair at most once.
 *
 * Emitters must still tolerate a duplicate: the process can crash after the
 * event is delivered but before the checkpoint is written.
 */
export function durableEmitter(
  step: DurableStep,
  emit: ReconcilerEventEmitter | undefined,
): EmitStep {
  return async function* (event) {
    if (!emit) return;
    yield* step.run(emitKey(event), () => emit(event));
  };
}

function emitKey(event: ReconcilerEvent): string {
  return event.event === "reconciler.operation.lifecycle"
    ? `emit:${event.event}:${event.operation}:${event.status}`
    : `emit:${event.event}`;
}

function scopeStore<T>(
  store: WorkflowStore<T>,
  prefix: string,
): WorkflowStore<T> {
  const scoped = (key: string) => `${prefix}:${key}`;

  return {
    ...store,
    get: (key?: string) => store.get(key === undefined ? key : scoped(key)),
    select: (key, selector) => store.select(scoped(key), selector),
    update: (key, updater) => store.update(scoped(key), updater),
    updateFrom: (key, snapshot, updater) =>
      store.updateFrom(scoped(key), snapshot, updater),
    deleteFrom: (key, snapshot) => store.deleteFrom(scoped(key), snapshot),
    when: ((arg1: any, arg2?: any) =>
      typeof arg1 === "string"
        ? store.when(scoped(arg1), arg2)
        : store.when(arg1)) as WorkflowStore<T>["when"],
    take: (key, selector, claim) => store.take(scoped(key), selector, claim),
  };
}
