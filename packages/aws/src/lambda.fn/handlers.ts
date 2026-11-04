import {
  handlerKinds,
  type Handle,
  type HandlerKind,
  type LambdaHandler,
} from "src/shared/handle";

export type { Handle, HandlerKind, LambdaHandler };

// Marks the functions that `handle.*` returns with their kind, so the
// dispatcher can tell handlers from other exported functions. `Symbol.for`
// gives the same symbol to every copy of this package.
const handlerKind = Symbol.for("@notation/aws/handler");

export function getHandlerKind(value: unknown): HandlerKind | undefined {
  if (typeof value !== "function") return undefined;
  return (value as any)[handlerKind];
}

// Wraps each handler in an async function, so that calling it returns a
// promise, as its `Handler` type says.
const handle = Object.fromEntries(
  Object.entries(handlerKinds).map(([method, kind]) => [
    method,
    (handler: (...args: any[]) => unknown) => {
      const wrapped = async (...args: any[]) => handler(...args);
      Object.defineProperty(wrapped, handlerKind, { value: kind });
      return wrapped;
    },
  ]),
) as unknown as Handle;

/**
 * The runtime half of `lambda()` from `@notation/aws/lambda`. In a function's
 * bundle, the compiler replaces each `lambda(...)` call with a call to this,
 * without its settings, which only the infra phase reads. Each method of
 * `handle` returns the handler, marked with its kind.
 */
export function lambda(): { handle: Handle } {
  return { handle };
}
