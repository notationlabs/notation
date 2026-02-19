import { operation } from "./operation.base";
import { BaseResource } from "src/orchestrator/resource";
import type { StateBackend } from "@notation/state";

export const deleteResource = operation("Destroying", delete_);

async function delete_(opts: { resource: BaseResource; state: StateBackend }) {
  const { resource, state } = opts;

  try {
    await resource.delete(resource.key, resource.toState(resource.output));
  } catch (err: any) {
    // @todo: declare these in the resource provider
    if (
      [
        "NotFoundException",
        "ResourceNotFoundException",
        "NoSuchEntityException",
      ].includes(err.name) ||
      ["ENOENT"].find((srt) => err.message.includes(srt))
    ) {
      console.log(
        `Resource ${resource.type} ${resource.id} has already been deleted. \n→ Removing from state.\n`,
      );
    } else {
      throw err;
    }
  }

  await state.delete(resource.id);
}
