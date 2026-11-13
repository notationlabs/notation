import {
  createLoggerReconcilerSubscriber,
  planApp,
  PROMPT_SOURCE,
  resolveDeploymentId,
  type Deployment,
  type Plan,
  type PlanNode,
} from "@notation/core";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type PlanCommandOptions = {
  json?: boolean;
  logger?: Logger;
};

const decisionSymbols: Record<PlanNode["decision"], string> = {
  create: "+",
  update: "~",
  replace: "-/+",
  "drift-update": "~",
  "drift-replace": "-/+",
  "drift-recreate": "±",
  "delete-orphan": "-",
  "delete-retired": "-",
  noop: " ",
};

const replaceOrders: Record<
  NonNullable<PlanNode["replaceOrder"]>,
  { symbol: string; label: string }
> = {
  "create-first": { symbol: "+/-", label: " (create, then delete)" },
  "delete-first": { symbol: "-/+", label: " (delete, then create)" },
};

export async function plan(
  deployment: Deployment,
  opts: PlanCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = createLoggerReconcilerSubscriber({ logger });
  if (opts.json) {
    let result: Plan;
    const { restore } = redirectStdoutToStderr();
    try {
      await compile(deployment, { logger });
      result = await planApp({ deployment, emit });
    } finally {
      restore();
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  await compile(deployment, { logger });
  logger.info(`Planning ${resolveDeploymentId(deployment)}\n`);
  const result = await planApp({ deployment, emit });
  printPlanSummary(result, logger);
}

// A delete-first replace plans the record's retired instances before it, with
// the same ID, so a lookup by ID skips them.
function findRecordNode(result: Plan, id: string): PlanNode | undefined {
  return result.nodes.find(
    (node) => node.id === id && node.decision !== "delete-retired",
  );
}

// A delete-first replace of the record deletes its retired instances with
// the resource. When the replace is only possible, the sweep deletes them if
// deploy does not replace the resource.
function retiredDeleteTime(result: Plan, id: string): string {
  const replace = result.nodes.find(
    (node) => node.id === id && node.replaceOrder === "delete-first",
  );
  if (!replace) return "deleted at the end of the deploy";
  const forcing = replace.replacedDependency
    ? findRecordNode(result, replace.replacedDependency)
    : replace;
  return forcing?.replaceFields?.some((field) => field.known)
    ? "deleted before the resource is replaced"
    : "deleted before the resource is replaced, or at the end of the deploy if it is not replaced";
}

function printPlanSummary(result: Plan, logger: Logger) {
  const changedNodes = result.nodes.filter((node) => node.decision !== "noop");

  for (const node of changedNodes) {
    const order = node.replaceOrder && replaceOrders[node.replaceOrder];
    logger.info(
      `${order?.symbol ?? decisionSymbols[node.decision]} ${node.decision} ${node.type} ${node.id}${order?.label ?? ""}`,
    );
    if (node.retiredAt) {
      logger.info(
        `    the instance that a replace retired at ${node.retiredAt}, ${retiredDeleteTime(result, node.id)}`,
      );
    }
    for (const field of node.replaceFields ?? []) {
      logger.info(
        field.known
          ? `    ${field.name} forces replacement`
          : `    ${field.name} unknown, may force replacement`,
      );
    }
    if (node.brokenDependents) {
      const certain = node.replaceFields?.some((field) => field.known);
      logger.info(
        `    the references from ${node.brokenDependents.join(", ")} are broken until deploy updates them${certain ? "" : ", if it is replaced"}`,
      );
    }
    if (node.mayTakeOver) {
      logger.info(
        `    recovers a create that an earlier deploy did not finish`,
      );
    }
    if (node.replacedDependency) {
      const replaced = findRecordNode(result, node.replacedDependency);
      // Deploy deletes the dependent only if it replaces the dependency.
      const certain = replaced?.replaceFields?.some((field) => field.known);
      logger.info(
        certain
          ? `    deleted before ${node.replacedDependency} is replaced`
          : `    deleted if ${node.replacedDependency} is replaced`,
      );
    }
    if (promptsForValue(node)) {
      logger.info(
        "    value not set: deploy asks for it if the secret doesn't exist, and fails without a terminal",
      );
    }
    if (node.placeholder) {
      logger.info(
        `    created first without the contributions that refer to ${(node.cycle ?? []).join(", ")}, the other members of its cycle`,
      );
    }
  }

  const count = (decision: PlanNode["decision"]) =>
    result.nodes.filter((node) => node.decision === decision).length;

  const summary = [
    `${count("create")} to create`,
    `${count("update") + count("drift-update")} to update`,
    `${count("replace") + count("drift-replace")} to replace`,
    `${count("drift-recreate")} to recreate`,
    `${count("delete-orphan") + count("delete-retired")} to delete`,
    `${count("noop")} unchanged`,
  ].join(", ");

  logger.info(`${changedNodes.length > 0 ? "\n" : ""}Plan: ${summary}.`);
}

const creatingDecisions = new Set<PlanNode["decision"]>([
  "create",
  "replace",
  "drift-replace",
  "drift-recreate",
]);

// A secret without a source has `ValueFrom: { Source: PROMPT_SOURCE }`. Plan
// never asks for the value, so it says that deploy will.
function promptsForValue(node: PlanNode): boolean {
  const valueFrom = node.params.ValueFrom as { Source?: unknown } | undefined;
  return (
    creatingDecisions.has(node.decision) && valueFrom?.Source === PROMPT_SOURCE
  );
}
