import { HandlerRef } from "@notation/resource";
import type { LambdaGroup, LambdaRef } from "src/lambda";
import type { HandlerKind } from "src/shared";

// Stands in for a handler that the infra phase has linked to its export. `E`
// is the handler's event; `any` fits every infra API.
export const runtimeRef = <E = any>(
  fn: LambdaGroup,
  name: string,
  kind: HandlerKind = "api",
): LambdaRef<NoInfer<E>> => {
  const ref = new HandlerRef(kind, fn);
  ref.module = "runtime/test.ts";
  ref.export = name;
  return ref as unknown as LambdaRef<NoInfer<E>>;
};
