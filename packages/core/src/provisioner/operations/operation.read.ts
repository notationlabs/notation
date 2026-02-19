import { operation } from "./operation.base";
import { BaseResource } from "src/orchestrator/resource";
import type { StateBackend } from "@notation/state";

export const readResource = operation("Reading", read);

async function read(opts: { resource: BaseResource; state: StateBackend }) {
  const { resource, state } = opts;

  let backoff = 1000;

  if (!resource.read) {
    const params = await resource.getParams();
    const stateNode = await state.get(resource.id);
    if (!stateNode) return params;
    return { ...stateNode.output, ...params };
  }

  async function getSettledReadResult() {
    if (!resource.read) return {};
    const readResult = await resource.read(resource.key);

    const needsRetry = resource.retryReadOnCondition?.some((condition) => {
      if (!condition) return false;

      const { key, value, reason } = condition;
      const msg = `[Info]: ${reason}`;

      if (value && readResult[key] !== value) {
        console.log(msg);
        return true;
      }

      if (!readResult[key]) {
        console.log(msg);
        return true;
      }

      return false;
    });

    if (needsRetry) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff *= 1.2;
      return getSettledReadResult();
    }

    return readResult;
  }

  try {
    const params = await resource.getParams();
    const result = await getSettledReadResult();
    return { ...params, ...result };
  } catch (err: any) {
    // todo: normalise not found errors within resource class
    // add logic for interpreting error in resource
    // if (err.name === "NoSuchEntityException") {
    //   return null;
    // }
    console.log(
      `[Error]: Reading remote resource ${resource.type} ${resource.id}`,
    );
    throw err;
  }
}
