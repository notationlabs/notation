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
import {
  NodeDurableRuntime,
  loadProject,
  resolveDeployment,
  resolveDeploymentIdentity,
  resolveEntryPoint,
  setConfigFile,
} from "@notation/core";

const configOption = [
  "--config <path>",
  "config file to use (defaults to the nearest notation.config.ts)",
] as const;
const stageOption = [
  "--stage <stage>",
  "stage to deploy to (defaults to defaultStage in the config)",
] as const;

program
  .command("compile")
  .option(...configOption)
  .description("Compile Notation App")
  .action(async (options) => {
    const project = await load(options);
    await compile(resolveEntryPoint(project));
  });

program
  .command("dashboard")
  .option(...configOption)
  .option(...stageOption)
  .description("Start Notation Dashboard")
  .action(async (options) => {
    const project = await load(options);
    const deployment = resolveDeploymentIdentity(project, {
      stage: options.stage,
    });
    const runtime = new NodeDurableRuntime({ deployment });
    await startDashboardServer({ state: runtime.state });
  });

program
  .command("deploy")
  .option(...configOption)
  .option(...stageOption)
  .description("Deploy Notation App")
  .option("--json", "stream reconciler events as NDJSON")
  .option("--execution-id <id>", "resume a durable execution")
  .option("--no-compile", "deploy the existing build without compiling")
  .option("--no-drift-detection", "skip drift detection")
  .action(async (options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await deploy(deployment, {
      json: options.json,
      executionId: options.executionId,
      compile: options.compile,
      driftDetection: options.driftDetection,
    });
  });

program
  .command("destroy")
  .option(...configOption)
  .option(...stageOption)
  .description("Destroy Notation App")
  .option("--json", "stream reconciler events as NDJSON")
  .option("--execution-id <id>", "resume a durable execution")
  .action(async (options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await destroy(deployment, {
      json: options.json,
      executionId: options.executionId,
    });
  });

program
  .command("plan")
  .option(...configOption)
  .option(...stageOption)
  .description("Plan Notation App")
  .option("--json", "print the plan as JSON")
  .action(async (options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await plan(deployment, { json: options.json });
  });

program
  .command("viz")
  .option(...configOption)
  .description("Visualise Notation App")
  .action(async (options) => {
    const project = await load(options);
    await visualise(resolveEntryPoint(project));
  });

program
  .command("watch")
  .option(...configOption)
  .option(...stageOption)
  .description("Watch Notation App")
  .action(async (options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await watch(deployment);
  });

function load(options: { config?: string }) {
  if (options.config !== undefined) setConfigFile(options.config);
  return loadProject();
}

process.exitCode = await runWithErrorHandling(
  () => program.parseAsync(process.argv),
  { logger: defaultLogger, command: process.argv[2] ?? program.name() },
);
