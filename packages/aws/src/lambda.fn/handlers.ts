import type { LambdaGroup } from "src/lambda";
import { handlerKinds, type Handle, type HandlerKind } from "src/shared/handle";

export type { HandlerKind };

// Marks the functions that `handle.*` returns with their kind, so the
// dispatcher can tell handlers from other exported functions. `Symbol.for`
// gives the same symbol to every copy of this package.
const handlerKind = Symbol.for("@notation/aws/handler");

export function getHandlerKind(value: unknown): HandlerKind | undefined {
  if (typeof value !== "function") return undefined;
  return (value as any)[handlerKind];
}

const handle = Object.fromEntries(
  Object.entries(handlerKinds).map(([method, kind]) => [
    method,
    (handler: Function) => {
      Object.defineProperty(handler, handlerKind, {
        value: kind,
        configurable: true,
      });
      return handler;
    },
  ]),
) as unknown as Handle<LambdaGroup>;

/**
 * The runtime half of `lambda()` from `@notation/aws/lambda`. In a function's
 * bundle, the compiler replaces each `lambda(...)` call with a call to this,
 * without its settings, which only the infra phase reads. Each method of
 * `handle` marks the handler with its kind and returns it.
 */
export function lambda(): { handle: Handle<LambdaGroup> } {
  return { handle };
}
