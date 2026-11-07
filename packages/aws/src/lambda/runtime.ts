import {
  createDecode,
  createRuntimeEnv,
  type EnvVars,
  type Lambda,
  type LambdaEvent,
} from "./declaration";
import type { LambdaDeclarationConfig } from "./lambda-declaration";

// The runtime build resolves `@notation/aws/lambda` to this module, through
// the `notation-runtime` export condition. It has the same exports as
// `index.ts`, so the same imports link in both builds, but none of the infra
// code. The types come from `index.ts` in both builds.

export * from "./declaration";
export { isNameSafe, LAMBDA_ID_MAX_LENGTH } from "./lambda-id";

/** The function's view of its declaration: `env()` and `decode()`. */
export function $lambda<
  const Id extends string,
  E extends LambdaEvent | undefined = undefined,
  Env extends EnvVars = {},
>(config: LambdaDeclarationConfig<Id, E, Env>): Lambda<E, Env> {
  return {
    id: config.id,
    env: createRuntimeEnv(config),
    decode: createDecode(config),
  } as unknown as Lambda<E, Env>;
}

const infraOnly = (name: string) =>
  new Error(`${name} declares infrastructure, so it can't run in a function.`);

export function lambda(): never {
  throw infraOnly("lambda()");
}

export class LambdaGroup {
  constructor() {
    throw infraOnly("LambdaGroup");
  }
}

export function isLambdaGroup(_value: unknown): false {
  return false;
}
