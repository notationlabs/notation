export type * from "./declaration";
export {
  $durableObject,
  type DurableObjectContainerConfig,
  type DurableObjectDeclarationConfig,
} from "./durable-object";
export {
  $worker,
  addBindings,
  isWorkerGroup,
  worker,
  WorkerGroup,
  type WorkerConfig,
  type WorkerDeclarationConfig,
  type WorkerGroupCode,
  type WorkerGroupConfig,
} from "./worker";
export { entrypointType } from "./entrypoint";
export { json } from "./json";
export { KVJsonError, readKVJson } from "./kv-json";
// The return types of $worker and worker() name these types. TypeScript
// names the type of a declaration through this module when the project
// doesn't depend on @notation/resource.
export type {
  CredentialRef,
  Derived,
  OutputRef,
  Resolved,
  ResolvedValues,
} from "@notation/resource";
