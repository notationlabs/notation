import type { StepRunner } from "./operations";

export async function runOperation<T>(
  operation: AsyncGenerator<unknown, T, unknown>,
) {
  let next = await operation.next();
  while (!next.done) {
    next = await operation.next();
  }
  return next.value;
}

export function createStepRunner(): StepRunner {
  const runner: StepRunner = {
    async *run<T>(_key: string, fn: () => T | Promise<T>) {
      return await fn();
    },
    async *delay(_key: string, ms: number) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    // Nothing is replayed in process, so no step key is ever read and a scope
    // has nothing to namespace: one runner serves every scope.
    scope: () => runner,
  };

  return runner;
}
