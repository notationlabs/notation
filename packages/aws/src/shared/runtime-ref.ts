import type { Handler, RuntimeRef } from "@notation/resource";
import type { LambdaGroup } from "src/lambda";

/** A handler that `handle.<kind>(fn)` returns, for a Lambda handler `H`. */
export type LambdaHandler<H extends (event: any, context: any) => unknown> =
  Handler<Parameters<H>[0], Awaited<ReturnType<H>>, LambdaGroup>;

/** How infra sees a Lambda handler of event `E`. */
export type LambdaRef<E, R = unknown> = RuntimeRef<E, R, LambdaGroup>;

/**
 * What an infra API such as `route()` invokes: a handler of event `E`
 * imported `with { type: "runtime" }`, or a Lambda group from `lambda()` that
 * runs external code.
 */
export type HandlerTarget<E> = LambdaRef<E> | LambdaGroup;
