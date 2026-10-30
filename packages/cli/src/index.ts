#!/usr/bin/env node
import { Option, program } from "commander";
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
  resolveEntryPoint,
} from "@notation/core";

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
    const project = await loadProject();
    await compile(project, resolveEntryPoint(project, entry));
  });

program
  .command("dashboard")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Start Notation Dashboard")
  .action(async (entry, options) => {
    const project = await loadProject();
    const deployment = resolveDeployment(project, {
      entry,
      stage: options.stage,
    });
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
  .addOption(
    new Option(
      "--app <app>",
      "fail unless the config names this app",
    ).hideHelp(),
  )
  .action(async (entry, options) => {
    const project = await loadProject();
    const deployment = resolveDeployment(project, {
      entry,
      stage: options.stage,
      app: options.app,
    });
    await deploy(project, deployment, {
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
    const project = await loadProject();
    const deployment = resolveDeployment(project, {
      entry,
      stage: options.stage,
    });
    await destroy(project, deployment, {
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
    const project = await loadProject();
    const deployment = resolveDeployment(project, {
      entry,
      stage: options.stage,
    });
    await plan(project, deployment, { json: options.json });
  });

program
  .command("viz")
  .argument(...entryArgument)
  .description("Visualise Notation App")
  .action(async (entry) => {
    const project = await loadProject();
    await visualise(project, resolveEntryPoint(project, entry));
  });

program
  .command("watch")
  .argument(...entryArgument)
  .option(...stageOption)
  .description("Watch Notation App")
  .action(async (entry, options) => {
    const project = await loadProject();
    const deployment = resolveDeployment(project, {
      entry,
      stage: options.stage,
    });
    await watch(project, deployment);
  });

process.exitCode = await runWithErrorHandling(
  () => program.parseAsync(process.argv),
  { logger: defaultLogger, command: process.argv[2] ?? program.name() },
);
