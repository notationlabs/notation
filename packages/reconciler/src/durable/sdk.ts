import type { WorkflowFn } from "@notation/durable";

export {
  WorkflowCancelledError,
  defineStore,
  registerErrorClass,
} from "@notation/durable";
export type { WorkflowStore } from "@notation/durable";
export { InfrastructureError } from "@notation/durable/runtime";
export type {
  DurableValue,
  StoreClient,
  StoreSnapshot,
} from "@notation/durable/runtime";

/** The durable step primitive the runtime hands to workflow functions. */
export type DurableStep = Parameters<WorkflowFn<any, any, any>>[0];
