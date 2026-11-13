import {
  stateReadsOf,
  type BaseResource,
  type RecordedOutputs,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";

/**
 * Reads, from state, the outputs that the `~state` refs of `resources` read.
 * A target with no record, or with a "creating" record, which holds no
 * outputs, gets null.
 */
export async function readRecordedOutputs(
  resources: BaseResource[],
  state: { get(id: string): Promise<StateNode | undefined> },
): Promise<RecordedOutputs> {
  const recorded: RecordedOutputs = {};
  for (const resource of resources) {
    const keys = stateReadsOf(resource);
    if (keys.length === 0) continue;
    const node = await state.get(resource.id);
    recorded[resource.id] =
      node && !isCreatingRecord(node)
        ? Object.fromEntries(
            keys
              .filter((key) => node.output[key] !== undefined)
              .map((key) => [key, node.output[key]]),
          )
        : null;
  }
  return recorded;
}
