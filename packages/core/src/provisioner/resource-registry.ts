import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistry,
  createResourceRegistryFromResources,
  resolveResourceClass,
  type MissingResourceRegistryMatchWarningEvent,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { BaseResource } from "src/orchestrator/resource";

export {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistry,
  resolveResourceClass,
  type MissingResourceRegistryMatchWarningEvent,
  type ResourceRegistry,
};

export function createResourceRegistryFromGraph(
  resources: BaseResource[],
): ResourceRegistry {
  return createResourceRegistryFromResources(resources);
}
