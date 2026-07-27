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
  return {
    async *run<T>(
      arg1: string | (() => T | Promise<T>),
      arg2?: () => T | Promise<T>,
    ): AsyncGenerator<unknown, T, unknown> {
      const fn = (typeof arg1 === "string" ? arg2 : arg1) as
        (() => T | Promise<T>) | undefined;

      if (!fn) {
        throw new Error("Missing run function");
      }

      return await fn();
    },
    async *delay(
      arg1: string | number,
      arg2?: number,
    ): AsyncGenerator<unknown, void, unknown> {
      const ms = typeof arg1 === "number" ? arg1 : arg2;
      if (ms === undefined) {
        throw new Error("Missing delay duration");
      }

      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
