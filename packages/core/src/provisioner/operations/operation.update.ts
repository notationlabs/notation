import { operation } from "./operation.base";
import { BaseResource } from "src/orchestrator/resource";
import type { StateBackend } from "@notation/state";
import { readResource } from ".";

export const updateResource = operation("Updating", update);

async function update(opts: {
  resource: BaseResource;
  state: StateBackend;
  patch: any;
}): Promise<void> {
  const { resource, state, patch } = opts;

  if (!resource.update) {
    throw new Error(
      `Update not implemented for ${resource.type} ${resource.id}`,
    );
  }

  const params = await resource.getParams();

  await resource.update(
    resource.key,
    patch,
    params,
    resource.toState(resource.output),
  );
  resource.setOutput({ ...resource.key, ...params });

  const result = await readResource({ resource, state, quiet: true });
  resource.setOutput({ ...resource.output, ...result });

  await state.update(resource.id, {
    lastOperation: "update",
    lastOperationAt: new Date().toISOString(),
    params: resource.toState(params),
    output: resource.toState(resource.output),
  });
}
