import {
  createResourceRegistry,
  createResourceRegistryFromResources,
  resolveResourceClass,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { BaseResource } from "src/orchestrator/resource";

export { createResourceRegistry, resolveResourceClass, type ResourceRegistry };

export function createResourceRegistryFromGraph(
  resources: BaseResource[],
): ResourceRegistry {
  return createResourceRegistryFromResources(resources);
}
