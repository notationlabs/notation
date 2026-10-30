#!/usr/bin/env node
import { program } from "commander";
import { compile } from "./compile";
import { deploy } from "./deploy";
import { destroy } from "./destroy";
import { plan } from "./plan";
import { defaultLogger } from "./logger";
import { runWithErrorHandling } from "./run-with-error-handling";
import { visualise } from "./visualise";
import { watch } from "./watch";
import { startDashboardServer } from "@notation/dashboard";
import { NodeDurableRuntime } from "@notation/core";
import { loadDeployment, loadEntryPoint } from "./config";

const entryArgument = [
  "<entry>",
  "entry name from notation.config.ts",
] as const;
const stageOption = [
  "--stage <stage>",
  "stage to deploy to (defaults to defaultStage in notation.config.ts)",
] as const;

program
  .command("compile")
  .argument(...entryArgument)
  .description("Compile Notation App")
  .action(async (entry) => {
    await compile(await loadEntryPoint(entry));
  });

program
  .command("dashboard")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Start Notation Dashboard")
  .action(async (entry, options) => {
    const deployment = await loadDeployment({ entry, stage: options.stage });
    const runtime = new NodeDurableRuntime({ deployment });
    await startDashboardServer({ state: runtime.state });
  });

program
  .command("deploy")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Deploy Notation App")
  .option("--json", "stream reconciler events as NDJSON")
  .option("--execution-id <id>", "resume a durable execution")
  .option("--no-compile", "deploy the existing build without compiling")
  .option("--no-drift-detection", "skip drift detection")
  .action(async (entry, options) => {
    const deployment = await loadDeployment({ entry, stage: options.stage });
    await deploy(deployment, {
      json: options.json,
      executionId: options.executionId,
      compile: options.compile,
      driftDetection: options.driftDetection,
    });
  });

program
  .command("destroy")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Destroy Notation App")
  .option("--json", "stream reconciler events as NDJSON")
  .option("--execution-id <id>", "resume a durable execution")
  .action(async (entry, options) => {
    const deployment = await loadDeployment({ entry, stage: options.stage });
    await destroy(deployment, {
      json: options.json,
      executionId: options.executionId,
    });
  });

program
  .command("plan")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Plan Notation App")
  .option("--json", "print the plan as JSON")
  .action(async (entry, options) => {
    const deployment = await loadDeployment({ entry, stage: options.stage });
    await plan(deployment, { json: options.json });
  });

program
  .command("viz")
  .argument(...entryArgument)
  .description("Visualise Notation App")
  .action(async (entry) => {
    await visualise(await loadEntryPoint(entry));
  });

program
  .command("watch")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Watch Notation App")
  .action(async (entry, options) => {
    await watch(await loadDeployment({ entry, stage: options.stage }));
  });

process.exitCode = await runWithErrorHandling(
  () => program.parseAsync(process.argv),
  { logger: defaultLogger, command: process.argv[2] ?? program.name() },
);
