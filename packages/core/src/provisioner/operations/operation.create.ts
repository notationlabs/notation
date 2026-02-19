import { operation } from "./operation.base";
import { BaseResource } from "src/orchestrator/resource";
import { State } from "../state";
import { readResource } from ".";

export const createResource = operation("Creating", create);

async function create(opts: { resource: BaseResource; state: State }) {
  const { resource, state } = opts;
  let backoff = 1000;

  try {
    const params = await resource.getParams();
    const maybeComputedPrimaryKey = await resource.create(params);

    resource.setOutput(params);

    if (maybeComputedPrimaryKey) {
      resource.setOutput({ ...maybeComputedPrimaryKey, ...resource.output });
    }

    const readResult = await readResource({ resource, state, quiet: true });

    resource.setOutput({ ...resource.output, ...readResult });

    await state.update(resource.id, {
      id: resource.id,
      groupId: resource.groupId,
      groupType: resource.groupType,
      type: resource.type,
      lastOperation: "create",
      lastOperationAt: new Date().toISOString(),
      config: resource.config,
      params: resource.toState(params),
      output: resource.toState(resource.output),
    });
  } catch (err: any) {
    if (
      resource.retryLaterOnError &&
      resource.retryLaterOnError.some(
        (retry) => retry.name === err.name && retry.message === err.message,
      )
    ) {
      console.log(`[Retry]: Creating ${resource.type} ${resource.id}`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff *= 1.5;
      await create(opts);
    }
    // else if (err.name === "ConflictException") {
    //   // todo: provide some means to requisition the resource
    //   console.log(
    //     `[Info]: Resource ${resource.type} ${resource.id} already exists but isn't owned by Notation.`,
    //   );
    //   throw err;
    // }
    else {
      throw err;
    }
  }
}
