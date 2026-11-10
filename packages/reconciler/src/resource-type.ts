import { hasTag, type BaseResource } from "@notation/resource";
import type { StateNode } from "@notation/state";

export class ResourceTypeChangedError extends Error {
  readonly _tag = "ResourceTypeChangedError" as const;

  constructor(resourceId: string, stateType: string, graphType: string) {
    super(
      `Resource ${resourceId} has type ${graphType} in the graph, but its ` +
        `state record has type ${stateType}. A resource can't change type ` +
        `under the same ID. The provider must give the ${graphType} resource ` +
        `a new ID, so that the ${stateType} record is deleted as an orphan.`,
    );
    this.name = "ResourceTypeChangedError";
  }

  static is(error: unknown): error is ResourceTypeChangedError {
    return hasTag(error, "ResourceTypeChangedError");
  }
}

export function assertSameType(
  resource: BaseResource,
  stateNode: Pick<StateNode, "type"> | undefined,
): void {
  if (stateNode && stateNode.type !== resource.type) {
    throw new ResourceTypeChangedError(
      resource.id,
      stateNode.type,
      resource.type,
    );
  }
}
