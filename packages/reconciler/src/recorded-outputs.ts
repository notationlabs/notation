import {
  isStateRefTarget,
  type BaseResource,
  type RecordedOutputs,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";

/**
 * Reads, from state, the outputs of the targets of `~state` refs among
 * `resources`. A target with no record, or with a "creating" record, which
 * holds no outputs, gets null.
 */
export async function readRecordedOutputs(
  resources: BaseResource[],
  state: { get(id: string): Promise<StateNode | undefined> },
): Promise<RecordedOutputs> {
  const recorded: RecordedOutputs = {};
  for (const resource of resources) {
    if (!isStateRefTarget(resource)) continue;
    const node = await state.get(resource.id);
    recorded[resource.id] =
      node && !isCreatingRecord(node) ? node.output : null;
  }
  return recorded;
}
