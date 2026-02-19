import type { BaseResource } from "./resource";
import type {
  ResourceCollector as ResourceCollectorContract,
  ResourceGroup,
} from "@notation/resource";

export class ResourceCollector implements ResourceCollectorContract {
  private resourceGroups: ResourceGroup[] = [];
  private resources: BaseResource[] = [];
  private nextResourceGroupId = 0;

  allocateResourceGroupId(): number {
    return this.nextResourceGroupId++;
  }

  registerResourceGroup(group: ResourceGroup) {
    this.resourceGroups.push(group);
  }

  registerResource(resource: BaseResource) {
    if (this.resources.includes(resource)) {
      throw new Error(`Resource ${resource.type} has already been registered.`);
    }

    this.resources.push(resource);
  }

  getResourceGroups() {
    return this.resourceGroups;
  }

  getResources() {
    return this.resources;
  }
}
