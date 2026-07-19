import type { BaseResource } from "./resource";
import {
  getActiveResourceCollection,
  type ResourceGraph,
} from "./resource-collection";

export type ResourceGroupOptions = {
  /**
   * Optional pre-assigned ID. Used outside graph collection.
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

  #graph?: ResourceGraph;

  constructor(type: string, opts: ResourceGroupOptions) {
    const { dependencies, id, ...config } = opts;
    const collection = getActiveResourceCollection();
    this.type = type;
    this.#graph = collection?.graph;
    this.id = collection ? collection.nextResourceGroupId++ : (id ?? -1);
    this.dependencies = dependencies || {};
    this.config = config || {};
    this.resources = [];

    collection?.graph.resourceGroups.push(this);
    return this;
  }

  add<T extends BaseResource>(resource: T) {
    if (this.#graph) {
      if (this.#graph.resources.includes(resource)) {
        throw new Error(
          `Resource ${resource.type} has already been registered.`,
        );
      }
      this.#graph.resources.push(resource);
    } else if (this.resources.includes(resource)) {
      throw new Error(`Resource ${resource.type} has already been registered.`);
    }
    resource.groupId = this.id;
    resource.groupType = this.type;
    this.resources.push(resource);
    return resource;
  }

  findResource<T extends new (...opts: any[]) => BaseResource>(
    ResourceClass: T,
  ) {
    return this.resources.find((r) => r instanceof ResourceClass) as
      InstanceType<T> | undefined;
  }
}
