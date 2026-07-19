import { planApp, type Plan, type PlanNode } from "@notation/core";
import { compile } from "./compile";
import { redirectStdoutToStderr } from "./stdio";

export type PlanCommandOptions = {
  json?: boolean;
};

const decisionSymbols: Record<PlanNode["decision"], string> = {
  create: "+",
  update: "~",
  "drift-update": "~",
  "drift-recreate": "±",
  "delete-orphan": "-",
  noop: " ",
};

export async function plan(entryPoint: string, opts: PlanCommandOptions = {}) {
  try {
    if (opts.json) {
      let result: Plan;
      const { restore } = redirectStdoutToStderr();
      try {
        await compile(entryPoint);
        result = await planApp(entryPoint);
      } finally {
        restore();
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    await compile(entryPoint);
    console.log(`Planning ${entryPoint}\n`);
    const result = await planApp(entryPoint);
    printPlanSummary(result);
  } catch (err: any) {
    if (err.name === "CredentialsProviderError") {
      console.log(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        "\n\nIf using another profile run AWS_PROFILE=otherProfile notation plan.\n",
      );
      process.exit(1);
    }
    throw err;
  }
}

function printPlanSummary(result: Plan) {
  const changedNodes = result.nodes.filter((node) => node.decision !== "noop");

  for (const node of changedNodes) {
    console.log(
      `${decisionSymbols[node.decision]} ${node.decision} ${node.type} ${node.id}`,
    );
  }

  const count = (decision: PlanNode["decision"]) =>
    result.nodes.filter((node) => node.decision === decision).length;

  const summary = [
    `${count("create")} to create`,
    `${count("update") + count("drift-update")} to update`,
    `${count("drift-recreate")} to recreate`,
    `${count("delete-orphan")} to delete`,
    `${count("noop")} unchanged`,
  ].join(", ");

  console.log(`${changedNodes.length > 0 ? "\n" : ""}Plan: ${summary}.`);
}
