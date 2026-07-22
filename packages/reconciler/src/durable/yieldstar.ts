import type { WorkflowFn } from "yieldstar";

export { RetryableError, defineStore } from "yieldstar";
export type { WorkflowStore } from "yieldstar";
export type { StandardSchemaV1, StoreClient } from "@yieldstar/core";

/** The durable step primitive the runtime hands to workflow functions. */
export type DurableStep = Parameters<WorkflowFn<any, any, any>>[0];
