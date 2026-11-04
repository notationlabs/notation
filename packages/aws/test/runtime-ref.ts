import { HandlerRef } from "@notation/resource";
import type { LambdaGroup, RuntimeRef } from "src/lambda";
import type { HandlerKind } from "src/shared";

// Stands in for a handler that the infra phase has linked to its export.
export const runtimeRef = <E = any>(
  fn: LambdaGroup,
  name: string,
  kind: HandlerKind = "api",
): RuntimeRef<E> => {
  const ref = new HandlerRef(kind, fn);
  ref.module = "runtime/test.ts";
  ref.export = name;
  return ref as unknown as RuntimeRef<E>;
};
