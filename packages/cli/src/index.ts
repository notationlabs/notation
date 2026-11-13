#!/usr/bin/env node
import { Option, program } from "commander";
import { compile } from "./compile";
import { deploy } from "./deploy";
import { destroy } from "./destroy";
import { plan } from "./plan";
import { defaultLogger } from "./logger";
import { runWithErrorHandling } from "./run-with-error-handling";
import { scrubOutput } from "./scrub";
import { secretDelete, secretSet } from "./secret";
import { visualise } from "./visualise";
import { watch } from "./watch";
import { startDashboardServer } from "@notation/dashboard";
import {
  NodeDurableRuntime,
  loadProject,
  readExecutionDeployment,
  resolveDeployment,
  resolveDeploymentIdentity,
  resolveBuild,
  setConfigFile,
  type Project,
} from "@notation/core";

// Maps stack frames in the compiled infra bundle back to the user's source,
// so a resource's declaredAt names the source file. Only modules loaded after
// this call are mapped, and the bundle is imported later.
process.setSourceMapsEnabled(true);

// Secret values that the process reads never reach its output, even when a
// provider echoes one back in an error.
scrubOutput();

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
    await compile(resolveBuild(project));
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
  .addOption(
    new Option(
      "--prompt-secrets",
      "ask on the terminal for secret values even with --json",
    ).hideHelp(),
  )
  .action(async (options) => {
    const project = await load(options);
    const deployment = await resolveResumableDeployment(project, options);
    await deploy(deployment, {
      json: options.json,
      executionId: options.executionId,
      resumeCommand: resumeCommand("deploy", options),
      compile: options.compile,
      driftDetection: options.driftDetection,
      promptSecrets: options.promptSecrets,
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
    const deployment = await resolveResumableDeployment(project, options);
    await destroy(deployment, {
      json: options.json,
      executionId: options.executionId,
      resumeCommand: resumeCommand("destroy", options),
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
    await visualise(resolveBuild(project));
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

const secret = program
  .command("secret")
  .description("Set or delete the values of secrets");

secret
  .command("set <id>")
  .option(...configOption)
  .option(...stageOption)
  .description(
    "Set a secret's value, from a hidden prompt on a terminal or from stdin",
  )
  .action(async (id: string, options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await secretSet(deployment, id);
  });

secret
  .command("delete <id>")
  .option(...configOption)
  .option(...stageOption)
  .option("--yes", "delete without asking for confirmation")
  .description("Delete a secret from its store")
  .action(async (id: string, options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await secretDelete(deployment, id, { yes: options.yes });
  });

function load(options: { config?: string }) {
  if (options.config !== undefined) setConfigFile(options.config);
  return loadProject();
}

// An execution that already exists saved its stage when it started, so the
// stage comes from the execution. An ID with no execution starts a new one.
async function resolveResumableDeployment(
  project: Project,
  options: { stage?: string; executionId?: string },
) {
  const saved =
    options.executionId === undefined
      ? undefined
      : await readExecutionDeployment(options.executionId);
  return resolveDeployment(project, {
    stage: options.stage,
    execution: saved && { id: options.executionId!, deployment: saved },
  });
}

// The command to print for resuming a crash. It omits --stage, because the
// stage comes from the execution.
function resumeCommand(command: string, options: { config?: string }) {
  const config =
    options.config === undefined ? "" : ` --config ${options.config}`;
  return `notation ${command}${config}`;
}

process.exitCode = await runWithErrorHandling(
  () => program.parseAsync(process.argv),
  { logger: defaultLogger, command: process.argv[2] ?? program.name() },
);
