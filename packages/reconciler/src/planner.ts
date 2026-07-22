import { ResourceNotFoundError, type BaseResource } from "@notation/resource";
import type { StateBackend } from "@notation/state";
import { setTimeout as sleep } from "node:timers/promises";
import { buildResourceDepthLevels } from "./dependency-graph";
import { runPendingOperation } from "./pending-operation";
import {
  decideAction,
  getDependencyIds,
  resolvePlanParams,
  type Plan,
  type PlanNode,
} from "./plan";

export type CreatePlanOptions = {
  resources: BaseResource[];
  state: StateBackend;
  driftDetection?: boolean;
  maxOperationAttempts?: number;
};

export async function createPlan({
  resources,
  state,
  driftDetection = true,
  maxOperationAttempts,
}: CreatePlanOptions): Promise<Plan> {
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const nodes: PlanNode[] = [];

  for (const level of buildResourceDepthLevels(resources)) {
    for (const resource of level) {
      const stateNode = await state.get(resource.id);
      if (stateNode) resource.setOutput(stateNode.output);
      const params = await resolvePlanParams(resource);
      let action = decideAction({ resource, stateNode, params });

      if (action.decision === "noop" && driftDetection && resource.read) {
        let driftRead;
        try {
          const output = await runOperation(
            runPendingOperation(
              createStepRunner(),
              `plan:${resource.id}:read`,
              (context) => resource.read!(resource.key, context),
              maxOperationAttempts,
            ),
          );
          driftRead = { kind: "present" as const, output };
        } catch (error) {
          if (!ResourceNotFoundError.is(error)) throw error;
          driftRead = { kind: "absent" as const };
        }

        action = decideAction({
          resource,
          stateNode,
          params,
          driftRead,
        });
      }

      nodes.push({
        id: resource.id,
        type: resource.type,
        decision: action.decision,
        ...("diff" in action ? { diff: action.diff } : {}),
        params,
        dependsOn: getDependencyIds(resource),
      });
    }
  }

  for (const stateNode of await state.values()) {
    if (resourceById.has(stateNode.id)) continue;
    nodes.push({
      id: stateNode.id,
      type: stateNode.type,
      decision: "delete-orphan",
      params: stateNode.params,
      dependsOn: [],
    });
  }

  return { createdAt: new Date().toISOString(), nodes };
}

async function runOperation<T>(
  operation: AsyncGenerator<unknown, T, unknown>,
) {
  let next = await operation.next();
  while (!next.done) {
    next = await operation.next();
  }
  return next.value;
}

function createStepRunner() {
  return {
    async *run<T>(
      _key: string,
      operation: () => T | Promise<T>,
    ): AsyncGenerator<unknown, T, unknown> {
      return await operation();
    },
    async *delay(
      _key: string,
      delayMs: number,
    ): AsyncGenerator<unknown, void, unknown> {
      await sleep(delayMs);
    },
  };
}
