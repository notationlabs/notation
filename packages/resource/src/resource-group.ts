import type { BaseResource } from "./resource";

export interface ResourceCollector {
  allocateResourceGroupId(): number;
  registerResourceGroup(group: ResourceGroup): void;
  registerResource(resource: BaseResource): void;
}

export type ResourceGroupOptions = {
  /**
   * Optional collector used by orchestration graph builders.
   *
   * When provided, the group ID is allocated by the collector and the group/resources
   * are registered into it.
   */
  collector?: ResourceCollector;

  /**
   * Optional pre-assigned ID. Only used when no collector is provided.
   */
  id?: number;

  dependencies?: Record<string, number>;
  [key: string]: any;
};

export abstract class ResourceGroup {
  type: string;
  id: number;
  dependencies: Record<string, number>;
  config: Record<string, any>;
  resources: BaseResource[];

  #collector?: ResourceCollector;

  constructor(type: string, opts: ResourceGroupOptions) {
    const { dependencies, collector, id, ...config } = opts;
    this.type = type;
    this.#collector = collector;
    this.id = collector ? collector.allocateResourceGroupId() : (id ?? -1);
    this.dependencies = dependencies || {};
    this.config = config || {};
    this.resources = [];

    if (collector) collector.registerResourceGroup(this);
    return this;
  }

  add<T extends BaseResource>(resource: T) {
    if (this.#collector) {
      this.#collector.registerResource(resource);
    } else if (this.resources.includes(resource)) {
      throw new Error(`Resource ${resource.type} has already been registered.`);
    }
    resource.groupId = this.id;
    resource.groupType = this.type;
    this.resources.push(resource);
    return resource;
  }

  findResource<T extends new (...opts: any[]) => BaseResource>(ResourceClass: T) {
    return this.resources.find((r) => r instanceof ResourceClass) as
      | InstanceType<T>
      | undefined;
  }
}
