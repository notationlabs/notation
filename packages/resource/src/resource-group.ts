import type { BaseResource } from "./resource";
import {
  getActiveResourceCollection,
  type ResourceGraph,
} from "./resource-collection";

export type ResourceGroupOptions<
  C extends Record<string, any> = Record<string, any>,
> = {
  /**
   * Optional pre-assigned ID. Used outside graph collection.
   */
  id?: number;

  config?: C;
};

export abstract class ResourceGroup<
  C extends Record<string, any> = Record<string, any>,
> {
  type: string;
  id: number;
  config: C;
  resources: BaseResource[];

  #graph?: ResourceGraph;

  constructor(type: string, opts: ResourceGroupOptions<C>) {
    const { id, config } = opts;
    const collection = getActiveResourceCollection();
    this.type = type;
    this.#graph = collection?.graph;
    this.id = collection ? collection.nextResourceGroupId++ : (id ?? -1);
    this.config = config || ({} as C);
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

  /**
   * Adds a resource unless the group already has one with the same ID, and
   * returns the one the group holds. Use it for resources that bind two
   * others, such as an API integration, which several call sites may create.
   */
  addOnce<T extends new (opts: any) => BaseResource>(
    ResourceClass: T,
    opts: ConstructorParameters<T>[0] & { id: string },
  ): InstanceType<T> {
    const existing = this.resources.find((r) => r.id === opts.id);
    if (!existing) {
      return this.add(new ResourceClass(opts) as InstanceType<T>);
    }
    if (existing.constructor !== ResourceClass) {
      throw new Error(
        `Resource ${opts.id} already exists as ${existing.type} in group ${this.type}.`,
      );
    }
    return existing as InstanceType<T>;
  }
}
