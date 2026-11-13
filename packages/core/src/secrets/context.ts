import { getSecretsState, type ExecutionContext } from "./state";

export type { ExecutionContext };

/**
 * Runs `fn` with an active deployment/execution context `{ stage, executionId }`
 * accessible via `getExecutionContext()`, preserving any enclosing prompt
 * handler or preset secret values.
 */
export function runWithExecutionContext<T>(
  context: Pick<ExecutionContext, "stage" | "executionId"> &
    Partial<Omit<ExecutionContext, "stage" | "executionId">>,
  fn: () => T,
): T {
  const { executionContextStorage } = getSecretsState();
  const parent = executionContextStorage.getStore();
  return executionContextStorage.run({ ...parent, ...context }, fn);
}

/**
 * Returns the active deployment/execution context, if inside `planApp`,
 * `deployApp`, `destroyApp`, or `runWithExecutionContext`.
 */
export function getExecutionContext(): ExecutionContext | undefined {
  const store = getSecretsState().executionContextStorage.getStore();
  if (store?.stage === undefined || store.executionId === undefined) {
    return undefined;
  }
  return store as ExecutionContext;
}

/**
 * Returns the active deployment/execution context or throws if none is active.
 */
export function requireExecutionContext(): ExecutionContext {
  const context = getExecutionContext();
  if (!context) {
    throw new Error(
      "No active execution context. Run inside planApp, deployApp, or runWithExecutionContext.",
    );
  }
  return context;
}
