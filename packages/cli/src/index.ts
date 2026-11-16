#!/usr/bin/env node
import { Option, program } from "commander";
import { compile } from "./compile";
import { deploy, parseOverrides } from "./deploy";
import { destroy } from "./destroy";
import { plan } from "./plan";
import { resolveOutputMode } from "./output";
import { defaultLogger } from "./logger";
import { runWithErrorHandling } from "./run-with-error-handling";
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

const configOption = [
  "--config <path>",
  "config file to use (defaults to the nearest notation.config.ts)",
] as const;
const stageOption = [
  "--stage <stage>",
  "stage to deploy to (defaults to defaultStage in the config)",
] as const;
const jsonOption = [
  "--json",
  "stream reconciler events as NDJSON (the default when stdout is not a terminal)",
] as const;
const collect = (value: string, previous: string[] = []) => [
  ...previous,
  value,
];
const replaceOption = (hash: string) =>
  [
    `--replace <id${hash}>`,
    `replace the resource with this ID in state, as for a param that forces replacement (repeatable)`,
    collect,
  ] as const;
const credentialOption = (version: string) =>
  [
    `--credential <id.credential${version}=variable>`,
    "give deploy the value of a credential without rotate, from the environment variable (repeatable)",
    collect,
  ] as const;
const overrideLossProtectionOption = [
  "--override-loss-protection <id>",
  "replace a resource that --replace names, though its class refuses the replace (repeatable)",
  collect,
] as const;
const prettyOption = () =>
  new Option(
    "--pretty",
    "print pretty output (the default on a terminal)",
  ).conflicts("json");

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
  .option(...jsonOption)
  .addOption(prettyOption())
  .option("--execution-id <id>", "resume a durable execution")
  .option("--no-compile", "deploy the existing build without compiling")
  .option("--no-drift-detection", "skip drift detection")
  .option(...replaceOption("@hash"))
  .option(...overrideLossProtectionOption)
  .option(...credentialOption("@version"))
  .action(async (options) => {
    const project = await load(options);
    const deployment = await resolveResumableDeployment(project, options);
    await deploy(deployment, {
      output: resolveOutputMode(options),
      executionId: options.executionId,
      resumeCommand: resumeCommand("deploy", options),
      compile: options.compile,
      driftDetection: options.driftDetection,
      overrides: parseOverrides(options),
      config: options.config,
    });
  });

program
  .command("destroy")
  .option(...configOption)
  .option(...stageOption)
  .description("Destroy Notation App")
  .option(...jsonOption)
  .addOption(prettyOption())
  .option("--execution-id <id>", "resume a durable execution")
  .action(async (options) => {
    const project = await load(options);
    const deployment = await resolveResumableDeployment(project, options);
    await destroy(deployment, {
      output: resolveOutputMode(options),
      executionId: options.executionId,
      resumeCommand: resumeCommand("destroy", options),
    });
  });

program
  .command("plan")
  .option(...configOption)
  .option(...stageOption)
  .description("Plan Notation App")
  .option(
    "--json",
    "print the plan as JSON (the default when stdout is not a terminal)",
  )
  .addOption(prettyOption())
  .option(...replaceOption("[@hash]"))
  .option(...overrideLossProtectionOption)
  .option(...credentialOption("[@version]"))
  .action(async (options) => {
    const project = await load(options);
    const deployment = resolveDeployment(project, { stage: options.stage });
    await plan(deployment, {
      output: resolveOutputMode(options),
      overrides: parseOverrides(options),
      config: options.config,
    });
  });

program
  .command("viz")
  .option(...configOption)
  .option(...stageOption)
  .description("Visualise Notation App")
  .action(async (options) => {
    const project = await load(options);
    await visualise(resolveDeployment(project, { stage: options.stage }));
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
