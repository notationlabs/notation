import type { LambdaGroup } from "src/lambda";
import type { LambdaRef } from "src/lambda";

// Stands in for a handler that infra imports `with { type: "runtime" }`.
// `E` is the handler's event; `any` fits every infra API.
export const runtimeRef = <E = any>(resource: LambdaGroup, name: string) =>
  ({ resource, export: name }) as unknown as LambdaRef<NoInfer<E>>;
