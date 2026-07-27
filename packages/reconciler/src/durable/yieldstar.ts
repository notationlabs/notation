import type { WorkflowFn } from "yieldstar";

export { defineStore } from "yieldstar";
export type { WorkflowStore } from "yieldstar";
export type { StoreClient } from "@yieldstar/core";

/** The durable step primitive the runtime hands to workflow functions. */
export type DurableStep = Parameters<WorkflowFn<any, any, any>>[0];
