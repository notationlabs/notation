import type {
  EmitStep,
  ReconcilerEvent,
  ReconcilerEventEmitter,
} from "../events";
import type { StepRunner } from "../operations";
import type { DurableStep } from "./yieldstar";

/**
 * A durable step runner: the operation seam plus the store handle, which only
 * the durable driver uses.
 */
export type DurableStepRunner = {
  run<T>(
    key: string,
    fn: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown>;
  delay(key: string, ms: number): AsyncGenerator<unknown, void, unknown>;
  /** Narrower than StepRunner's, so a scope keeps its store handle. */
  scope(prefix: string): DurableStepRunner;
  store: DurableStep["store"];
};

// A durable runner is one of the step runners the operations accept.
type AssertStepRunner = DurableStepRunner extends StepRunner ? true : never;
export type DurableStepRunnerIsStepRunner = AssertStepRunner;

/**
 * Namespaces the step keys of `step` so an operation can be written once and
 * replayed at several call sites without its keys colliding.
 *
 * Opening a store is not prefixed: yieldstar derives that key from the store
 * name and store id, which is already unique. The keys a store *handle* takes
 * are caller-supplied and are left alone too — a store outlives the scope
 * that opened it, so its call sites qualify their own keys.
 */
export function scopeStep(
  step: DurableStep,
  prefix: string,
): DurableStepRunner {
  const scoped = (key: string) => `${prefix}:${key}`;

  return {
    run: ((key: string, fn: any) =>
      step.run(scoped(key), fn)) as DurableStepRunner["run"],
    delay: (key: string, ms: number) => step.delay(scoped(key), ms),
    store: step.store,
    scope: (nested: string) => scopeStep(step, scoped(nested)),
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
  step: DurableStepRunner,
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
