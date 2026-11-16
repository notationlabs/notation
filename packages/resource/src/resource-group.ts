import type { BaseResource, ResourceGroupRef } from "./resource";
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
  /** The groups that were added to this group. */
  readonly groups: ResourceGroup[];

  #graph?: ResourceGraph;
  #parent: ResourceGroup | null = null;

  /**
   * @param id Identifies the group across deployments. Must be unique among
   * groups of the same type.
   */
  constructor(type: string, id: string, config?: C) {
    const collection = getActiveResourceCollection();
    if (collection) assertUniqueGroup(collection.graph, type, id);
    this.type = type;
    this.id = id;
    this.#graph = collection?.graph;
    this.config = config || ({} as C);
    this.resources = [];
    this.groups = [];

    collection?.graph.resourceGroups.push(this);
    return this;
  }

  /** The group this group was added to, or null if it is at the top level. */
  get parent(): ResourceGroupRef | null {
    return this.#parent?.ref ?? null;
  }

  /**
   * Identifies the group and its ancestors, ordered from the outermost
   * group. Resources in the group record it as `resource.group`.
   */
  get ref(): ResourceGroupRef {
    const parents = [];
    for (let group = this.#parent; group; group = group.#parent) {
      parents.unshift({ type: group.type, id: group.id });
    }
    return { type: this.type, id: this.id, parents };
  }

  /**
   * Puts a resource or a group in this group. A resource that was constructed
   * while the graph was being collected is already in the graph; any other
   * resource joins the graph here, and so does a group with its contents. A
   * resource or a group can be in one group only. A group can't be added to
   * itself or to one of the groups it is in.
   */
  add<T extends BaseResource | ResourceGroup>(member: T): T {
    if (member instanceof ResourceGroup) return this.#addGroup(member) as T;
    const resource = member as BaseResource;
    if (resource.group) {
      throw new Error(
        `Resource ${resource.type} "${resource.id}" has already been registered in group ${resource.group.type} "${resource.group.id}".`,
      );
    }
    if (this.#graph && !this.#graph.resources.includes(resource)) {
      this.#graph.resources.push(resource);
    }
    resource.group = this.ref;
    this.resources.push(resource);
    return member;
  }

  #addGroup(group: ResourceGroup) {
    for (
      let ancestor: ResourceGroup | null = this;
      ancestor;
      ancestor = ancestor.#parent
    ) {
      if (ancestor === group) {
        throw new Error(
          `Group ${group.type} "${group.id}" can't be added to ${group === this ? "itself" : `group ${this.type} "${this.id}", which it contains`}.`,
        );
      }
    }
    if (group.#parent) {
      throw new Error(
        `Group ${group.type} "${group.id}" has already been added to group ${group.#parent.type} "${group.#parent.id}".`,
      );
    }
    if (this.#graph) group.#join(this.#graph);
    group.#parent = this;
    group.#updateRefs();
    this.groups.push(group);
    return group;
  }

  // Puts the group and its contents in `graph`, for a group that was made
  // while no graph was being collected.
  #join(graph: ResourceGraph) {
    if (!graph.resourceGroups.includes(this)) {
      assertUniqueGroup(graph, this.type, this.id);
      graph.resourceGroups.push(this);
    }
    this.#graph = graph;
    for (const resource of this.resources) {
      if (!graph.resources.includes(resource)) graph.resources.push(resource);
    }
    for (const group of this.groups) group.#join(graph);
  }

  // Rewrites the refs that the group's resources, and those of the groups in
  // it, hold, once the group has a parent. A group's parent never changes
  // after that, so the refs stay correct.
  #updateRefs() {
    const ref = this.ref;
    for (const resource of this.resources) resource.group = ref;
    for (const group of this.groups) group.#updateRefs();
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

function assertUniqueGroup(graph: ResourceGraph, type: string, id: string) {
  if (
    graph.resourceGroups.some((group) => group.type === type && group.id === id)
  ) {
    throw new Error(
      `Duplicate ${type} id "${id}": another ${type} group in this deployment already uses it.`,
    );
  }
}
