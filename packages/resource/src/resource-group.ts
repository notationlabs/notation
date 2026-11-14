import type { BaseResource } from "./resource";
import {
  getActiveResourceCollection,
  type ResourceGraph,
} from "./resource-collection";

export abstract class ResourceGroup<
  C extends Record<string, any> = Record<string, any>,
> {
  readonly type: string;
  readonly id: string;
  readonly config: C;
  readonly resources: BaseResource[];

  #graph?: ResourceGraph;

  /**
   * @param id Identifies the group across deployments. Must be unique among
   * groups of the same type.
   */
  constructor(type: string, id: string, config?: C) {
    const collection = getActiveResourceCollection();
    if (
      collection?.graph.resourceGroups.some(
        (group) => group.type === type && group.id === id,
      )
    ) {
      throw new Error(
        `Duplicate ${type} id "${id}": another ${type} group in this deployment already uses it.`,
      );
    }
    this.type = type;
    this.id = id;
    this.#graph = collection?.graph;
    this.config = config || ({} as C);
    this.resources = [];

    collection?.graph.resourceGroups.push(this);
    return this;
  }

  /**
   * Puts the resource in this group. A resource that was constructed while
   * the graph was being collected is already in the graph; any other resource
   * joins the graph here. A resource can be in one group only.
   */
  add<T extends BaseResource>(resource: T) {
    if (resource.group) {
      throw new Error(
        `Resource ${resource.type} "${resource.id}" has already been registered in group ${resource.group.type} "${resource.group.id}".`,
      );
    }
    if (this.#graph && !this.#graph.resources.includes(resource)) {
      this.#graph.resources.push(resource);
    }
    resource.group = { type: this.type, id: this.id };
    this.resources.push(resource);
    return resource;
  }

  /**
   * Adds a resource unless the group already has one with the same ID, and
   * returns the one the group holds. Use it for resources that bind two
   * others, such as an API integration, which several call sites may create.
   */
  addOnce<T extends new (id: string, ...args: any[]) => BaseResource>(
    ResourceClass: T,
    id: string,
    ...args: T extends new (id: string, ...args: infer A) => any ? A : never
  ): InstanceType<T> {
    const existing = this.resources.find((r) => r.id === id);
    if (!existing) {
      return this.add(new ResourceClass(id, ...args) as InstanceType<T>);
    }
    if (existing.constructor !== ResourceClass) {
      throw new Error(
        `Resource ${id} already exists as ${existing.type} in group ${this.type}.`,
      );
    }
    return existing as InstanceType<T>;
  }
}
