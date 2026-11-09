import {
  createLoggerReconcilerSubscriber,
  createPlan,
  type Plan,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { Deployment } from "src/config/deployment";
import { getResourceGraph } from "src/orchestrator/graph";
import {
  loadProviderRegistry,
  mergeResourceRegistries,
  stateProviderPackages,
} from "../resource-registry";
import { withRuntime, type NodeDurableRuntime } from "../durable-runtime";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export type PlanAppOptions = {
  deployment: Deployment;
  driftDetection?: boolean;
  maxOperationAttempts?: number;
  registry?: ResourceRegistry;
  runtime?: NodeDurableRuntime;
  databasePath?: string;
  emit?: ReconcilerEventEmitter;
};

export async function planApp({
  deployment,
  // Defaulted in one place: the reconciler's drift gate treats absent as on.
  driftDetection,
  maxOperationAttempts,
  registry,
  runtime: suppliedRuntime,
  databasePath,
  emit = createLoggerReconcilerSubscriber(),
}: PlanAppOptions): Promise<Plan> {
  const graph = await getResourceGraph(deployment.entryPoint, {
    app: deployment.app,
    stage: deployment.stage,
  });
  return withRuntime(
    { deployment, runtime: suppliedRuntime, databasePath },
    async (runtime) => {
      // Deploy loads the same packages, so plan finds the same blocking
      // dependents as deploy.
      const providerRegistry = await loadProviderRegistry(
        stateProviderPackages(await runtime.state.values()),
      );
      return createPlan({
        resources: graph.resources,
        state: runtime.state,
        driftDetection,
        emit,
        maxOperationAttempts,
        registry: mergeResourceRegistries(providerRegistry, registry),
      });
    },
  );
}
