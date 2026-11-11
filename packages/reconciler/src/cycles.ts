import { hasTag, type BaseResource } from "@notation/resource";
import { buildDepthLevels } from "./dependency-graph";

/**
 * Resources that depend on each other. Deploy creates each placeholder first,
 * with its params without contributions, and updates it with its full params
 * once the others exist.
 */
export type ResourceCycle = {
  /**
   * In the order of the first pass: each member comes after the members it
   * depends on, where a placeholder counts only its fixed dependencies.
   */
  members: BaseResource[];
  placeholders: BaseResource[];
};

export type DeployUnit =
  | { kind: "resource"; resource: BaseResource }
  | { kind: "cycle"; cycle: ResourceCycle };

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
  for (const resource of resources) {
    if (ids.has(resource.id)) {
      throw new Error(`Duplicate resource id: ${resource.id}`);
    }
    ids.add(resource.id);
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
    const [first] = members;
    if (members.length === 1 && !edgesOf(first!).includes(first!)) {
      return { kind: "resource", resource: first! };
    }
    return { kind: "cycle", cycle: resolveCycle(members) };
  });
}

/** The resources of `units`, in order. */
export function unitResources(units: DeployUnit[]): BaseResource[] {
  return units.flatMap((unit) =>
    unit.kind === "resource" ? [unit.resource] : unit.cycle.members,
  );
}

/**
 * Picks the placeholders of a cycle. While the members still form a loop,
 * the first member of the loop, in input order, that can be a placeholder
 * and whose contributions close the loop becomes one. Its contributions no
 * longer count as edges.
 */
function resolveCycle(members: BaseResource[]): ResourceCycle {
  const inCycle = new Set(members);
  const placeholders = new Set<BaseResource>();
  const edgesOf = (resource: BaseResource) =>
    (placeholders.has(resource)
      ? resource.getFixedDependencies()
      : resource.getDependencies()
    ).filter((dependency) => inCycle.has(dependency));

  for (;;) {
    const loops = findStronglyConnected(members, edgesOf).filter(
      (loop) => loop.length > 1 || edgesOf(loop[0]!).includes(loop[0]!),
    );
    if (loops.length === 0) break;
    for (const loop of loops) {
      const chosen = loop.find(
        (member) =>
          !placeholders.has(member) && !placeholderBlocker(member, loop),
      );
      if (!chosen) throw unresolvableCycleError(loop);
      placeholders.add(chosen);
    }
  }

  const { levels } = buildDepthLevels(
    members,
    (member) => member.id,
    (member) => edgesOf(member).map((dependency) => dependency.id),
  );
  const ordered = levels.flat();
  return {
    members: ordered,
    placeholders: ordered.filter((member) => placeholders.has(member)),
  };
}

/**
 * Why `member` can't be created as a placeholder to break `loop`, or
 * undefined when it can.
 */
function placeholderBlocker(
  member: BaseResource,
  loop: BaseResource[],
): string | undefined {
  const inLoop = new Set(loop);
  const fixed = new Set(member.getFixedDependencies());
  const contributed = member
    .getDependencies()
    .filter((dependency) => inLoop.has(dependency) && !fixed.has(dependency));
  if (contributed.length === 0) {
    const peers = member
      .getDependencies()
      .filter((dependency) => inLoop.has(dependency))
      .map((dependency) => dependency.id);
    return `${member.id} depends on ${list(peers)} through its config, its dependencies or dependOn, not through contributions`;
  }
  return placeholderParamsBlocker(member);
}

/**
 * The members of `cycle` that deploy reverts to their placeholder params
 * before it replaces `replaced`: each refers to `replaced` only through its
 * contributions, and can go back to its placeholder params with an update.
 */
export function revertedPeers(
  cycle: ResourceCycle,
  replaced: BaseResource,
): BaseResource[] {
  return cycle.members.filter(
    (peer) =>
      peer !== replaced &&
      peer.getDependencies().includes(replaced) &&
      !peer.getFixedDependencies().includes(replaced) &&
      !placeholderParamsBlocker(peer),
  );
}

/**
 * Why `resource` can't go between its placeholder params and its full
 * params with an update, or undefined when it can.
 */
function placeholderParamsBlocker(resource: BaseResource): string | undefined {
  if (!resource.update) {
    return `${resource.type} has no update operation, so ${resource.id} can't be updated after it is created`;
  }
  for (const param of resource.getContributedParams()) {
    const item = resource.schema[param];
    if (item?.presence === "required") {
      return `${resource.id} takes ${param} from contributions, and ${param} is required`;
    }
    if (
      item?.propertyType === "param" &&
      (item.immutable || item.primaryKey || item.secondaryKey)
    ) {
      return `${resource.id} takes ${param} from contributions, and a change to ${param} replaces it`;
    }
  }
  return undefined;
}

function unresolvableCycleError(loop: BaseResource[]): ResourceCycleError {
  const reasons = loop
    .map((member) => `- ${placeholderBlocker(member, loop)}.`)
    .join("\n");
  return new ResourceCycleError(
    `The resources ${list(loop.map((member) => member.id))} depend on each other, and none of them can be created first. ` +
      `Deploy can create a member of a cycle first without its contributions, and update it once the others exist. ` +
      `This needs a member whose dependencies on the others come only from contributions, whose contributed params are optional and don't force a replacement, and whose type has an update operation.\n${reasons}`,
  );
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
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
