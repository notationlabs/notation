import {
  forcesReplacement,
  hasTag,
  type BaseResource,
} from "@notation/resource";
import { buildDepthLevels } from "./dependency-graph";

/**
 * Resources that deploy reconciles together. A unit is either one resource
 * that does not depend on itself, with no placeholders, or a cycle: resources
 * that depend on each other. Deploy creates each placeholder of a cycle
 * first, without the contributions that depend on other members, and updates
 * it with its full params once the others exist.
 */
export type DeployUnit = {
  /**
   * In the order of the first pass: each member comes after the members it
   * depends on, where a placeholder counts only its fixed dependencies.
   */
  members: BaseResource[];
  placeholders: BaseResource[];
};

/** A cycle always has a placeholder, as one is needed to break its loop. */
export function isCycle(unit: DeployUnit): boolean {
  return unit.placeholders.length > 0;
}

export class ResourceCycleError extends Error {
  readonly _tag = "ResourceCycleError" as const;

  constructor(message: string) {
    super(message);
    this.name = "ResourceCycleError";
  }

  static is(error: unknown): error is ResourceCycleError {
    return hasTag(error, "ResourceCycleError");
  }
}

/**
 * Orders resources for deploy. Each unit comes after the units it depends
 * on, and units keep their input order where the edges allow. Resources that
 * depend on each other form one cycle unit. Throws `ResourceCycleError` when
 * a cycle has no member that can be created as a placeholder.
 */
export function orderDeployUnits(resources: BaseResource[]): DeployUnit[] {
  const ids = new Set<string>();
  for (const { id } of resources) {
    if (ids.has(id)) throw new Error(`Duplicate resource id: ${id}`);
    ids.add(id);
  }
  const position = new Map(
    resources.map((resource, index) => [resource, index]),
  );
  const edgesOf = (resource: BaseResource) =>
    resource.getDependencies().filter((dependency) => position.has(dependency));
  // Sorted by their first member, so that units keep the input order.
  const components = findStronglyConnected(resources, edgesOf).sort(
    (a, b) => position.get(a[0]!)! - position.get(b[0]!)!,
  );

  const componentOf = new Map<BaseResource, number>();
  components.forEach((members, index) => {
    for (const member of members) componentOf.set(member, index);
  });
  const { levels } = buildDepthLevels(
    components.map((_, index) => index),
    (index) => String(index),
    (index) => {
      const dependencies = new Set<string>();
      for (const member of components[index]!) {
        for (const dependency of edgesOf(member)) {
          const other = componentOf.get(dependency)!;
          if (other !== index) dependencies.add(String(other));
        }
      }
      return [...dependencies];
    },
  );

  return levels.flat().map((index): DeployUnit => {
    const members = components[index]!;
    if (!isLoop(members, edgesOf)) return { members, placeholders: [] };
    return resolveCycle(members);
  });
}

/**
 * Picks the placeholders of a cycle. While the members still form a loop,
 * the first member of the loop, in input order, that can be a placeholder
 * and whose contributions close the loop becomes one. Its contributions no
 * longer count as edges.
 */
function resolveCycle(members: BaseResource[]): DeployUnit {
  const inCycle = new Set(members);
  const placeholders = new Set<BaseResource>();
  const edgesOf = (resource: BaseResource) =>
    (placeholders.has(resource)
      ? resource.getFixedDependencies()
      : resource.getDependencies()
    ).filter((dependency) => inCycle.has(dependency));

  for (;;) {
    // With no loop left, each component has one member, and the components
    // come after the components they depend on.
    const components = findStronglyConnected(members, edgesOf);
    const loops = components.filter((component) => isLoop(component, edgesOf));
    if (loops.length === 0) {
      const ordered = components.flat();
      return {
        members: ordered,
        placeholders: ordered.filter((member) => placeholders.has(member)),
      };
    }
    for (const loop of loops) {
      const candidates = loop
        .filter((member) => !placeholders.has(member))
        .map((member) => ({
          member,
          blocker: placeholderBlocker(member, loop, inCycle),
        }));
      const chosen = candidates.find(({ blocker }) => !blocker);
      if (!chosen) {
        throw unresolvableCycleError(
          loop,
          candidates.map(({ blocker }) => blocker!),
        );
      }
      placeholders.add(chosen.member);
    }
  }
}

/** A component that has more than one member, or a member that depends on itself. */
function isLoop<T>(component: T[], edgesOf: (item: T) => T[]): boolean {
  return component.length > 1 || edgesOf(component[0]!).includes(component[0]!);
}

/**
 * Why `member` can't be created as a placeholder to break `loop`, or
 * undefined when it can. `cycle` holds every member of the cycle that
 * `loop` is in.
 */
function placeholderBlocker(
  member: BaseResource,
  loop: BaseResource[],
  cycle: ReadonlySet<BaseResource>,
): string | undefined {
  const inLoop = new Set(loop);
  const fixed = new Set(member.getFixedDependencies());
  const contributed = member
    .getDependencies()
    .filter((dependency) => inLoop.has(dependency) && !fixed.has(dependency));
  if (contributed.length === 0) {
    const peers = member
      .getDependencies()
      .filter((dependency) => inLoop.has(dependency));
    return `${member.id} depends on ${listIds(peers)} through its config, its dependencies or dependOn, not through contributions`;
  }
  return placeholderParamsBlocker(member, cycle);
}

/**
 * The dependencies of `resource` that remain when the contributions that
 * depend on one of `excluded` are left out.
 */
export function remainingDependencies(
  resource: BaseResource,
  excluded: ReadonlySet<BaseResource>,
): BaseResource[] {
  const fixed = new Set(resource.getFixedDependencies());
  return resource
    .getDependencies()
    .filter((dependency) => fixed.has(dependency) || !excluded.has(dependency));
}

/**
 * Why `resource` can't go between its params without the contributions that
 * depend on `peers` and its full params with an update, or undefined when it
 * can.
 */
export function placeholderParamsBlocker(
  resource: BaseResource,
  peers: ReadonlySet<BaseResource>,
): string | undefined {
  if (!resource.update) {
    return `${resource.type} has no update operation, so ${resource.id} can't be updated after it is created`;
  }
  for (const param of resource.getContributedParams({ from: peers })) {
    const item = resource.schema[param];
    if (item?.presence === "required") {
      return `${resource.id} takes ${param} from contributions that refer to other members of its cycle, and ${param} is required`;
    }
    if (item && forcesReplacement(item)) {
      return `${resource.id} takes ${param} from contributions that refer to other members of its cycle, and a change to ${param} replaces it`;
    }
  }
  return undefined;
}

/**
 * `blockers` say why each member of `loop` that is not a placeholder yet
 * can't be one.
 */
function unresolvableCycleError(
  loop: BaseResource[],
  blockers: string[],
): ResourceCycleError {
  const reasons = blockers.map((blocker) => `- ${blocker}.`).join("\n");
  return new ResourceCycleError(
    `The resources ${listIds(loop)} depend on each other, and none of them can be created first. ` +
      `Deploy can create a member of a cycle first without its contributions, and update it once the others exist. ` +
      `This needs a member whose dependencies on the others come only from contributions, whose params that those contributions set are optional and don't force a replacement, and whose type has an update operation.\n${reasons}`,
  );
}

/** The IDs of `resources`, as "a, b and c". */
export function listIds(resources: BaseResource[]): string {
  const ids = resources.map(({ id }) => id);
  if (ids.length <= 1) return ids.join("");
  return `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/**
 * Tarjan's algorithm, without recursion. Returns the strongly connected
 * components, each in input order. An edge to an item that is not in `items`
 * must not be returned by `edgesOf`.
 */
export function findStronglyConnected<T>(
  items: T[],
  edgesOf: (item: T) => T[],
): T[][] {
  const order = new Map(items.map((item, index) => [item, index]));
  const index = new Map<T, number>();
  const low = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const components: T[][] = [];
  let next = 0;

  for (const root of items) {
    if (index.has(root)) continue;
    const frames: { item: T; edges: T[]; position: number }[] = [];
    const visit = (item: T) => {
      index.set(item, next);
      low.set(item, next);
      next += 1;
      stack.push(item);
      onStack.add(item);
      frames.push({ item, edges: edgesOf(item), position: 0 });
    };
    visit(root);

    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (frame.position < frame.edges.length) {
        const target = frame.edges[frame.position]!;
        frame.position += 1;
        if (!index.has(target)) {
          visit(target);
        } else if (onStack.has(target)) {
          low.set(
            frame.item,
            Math.min(low.get(frame.item)!, index.get(target)!),
          );
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) {
        low.set(
          parent.item,
          Math.min(low.get(parent.item)!, low.get(frame.item)!),
        );
      }
      if (low.get(frame.item) !== index.get(frame.item)) continue;
      const component: T[] = [];
      let member: T;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.item);
      component.sort((a, b) => order.get(a)! - order.get(b)!);
      components.push(component);
    }
  }
  return components;
}
