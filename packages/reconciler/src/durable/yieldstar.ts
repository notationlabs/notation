import type { WorkflowFn } from "yieldstar";

export { defineStore, registerErrorClass } from "yieldstar";
export type { WorkflowStore } from "yieldstar";
export { InfrastructureError } from "@yieldstar/core";
export type { DurableValue, StoreClient, StoreSnapshot } from "@yieldstar/core";

/** The durable step primitive the runtime hands to workflow functions. */
export type DurableStep = Parameters<WorkflowFn<any, any, any>>[0];
