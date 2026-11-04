import type { RuntimeRef } from "@notation/resource";
import type { LambdaGroup } from "./lambda";

/** How infra sees a Lambda handler of event `E`. */
export type LambdaRef<E, R = unknown> = RuntimeRef<E, R, LambdaGroup>;

/**
 * What an infra API such as `route()` invokes: a handler of event `E`
 * imported `with { type: "runtime" }`, or a Lambda group from `lambda()` that
 * runs external code.
 */
export type HandlerTarget<E> = LambdaRef<E> | LambdaGroup;
