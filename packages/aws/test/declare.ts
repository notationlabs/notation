import {
  declaredIn,
  type ResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import { isLambdaGroup, type LambdaGroup } from "src/lambda";

export const projectDir = "/some/project";

// Stands in for `v.unknown()`, the schema of a queue that takes any JSON body.
export const Unknown: StandardSchemaV1<unknown, unknown> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
};

// Records the module of a declaration, as the infra build does.
export const inModule = <T>(declaration: T, file = "runtime/fn.ts"): T =>
  declaredIn(declaration, file, "lambda");

export function lambdaGroup(graph: ResourceGraph, id: string): LambdaGroup {
  const group = graph.resourceGroups.find(
    (g) => isLambdaGroup(g) && g.id === id,
  );
  if (!group) throw new Error(`No lambda group ${id} in the graph`);
  return group as LambdaGroup;
}
