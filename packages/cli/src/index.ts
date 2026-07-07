#!/usr/bin/env node
import { program } from "commander";
import { compile } from "./compile";
import { deploy } from "./deploy";
import { destroy } from "./destroy";
import { plan } from "./plan";
import { visualise } from "./visualise";
import { watch } from "./watch";
import { startDashboardServer } from "@notation/dashboard";

program
  .command("compile")
  .argument("<entryPoint>", "entryPoint")
  .description("Compile Notation App")
  .action(async (entryPoint) => {
    await compile(entryPoint);
  });

program
  .command("dashboard")
  .description("Start Notation Dashboard")
  .action(async () => {
    await startDashboardServer();
  });

program
  .command("deploy")
  .argument("<entryPoint>", "entryPoint")
  .description("Deploy Notation App")
  .action(async (entryPoint) => {
    await deploy(entryPoint);
  });

program
  .command("destroy")
  .argument("<entryPoint>", "entryPoint")
  .description("Destroy Notation App")
  .action(async (entryPoint) => {
    await destroy(entryPoint);
  });

program
  .command("plan")
  .argument("<entryPoint>", "entryPoint")
  .description("Plan Notation App")
  .option("--json", "print the plan as JSON")
  .action(async (entryPoint, options) => {
    await plan(entryPoint, { json: options.json });
  });

program
  .command("viz")
  .argument("<entryPoint>", "entryPoint")
  .description("Visualise Notation App")
  .action(async (entryPoint) => {
    await visualise(entryPoint);
  });

program
  .command("watch")
  .argument("<entryPoint>", "entryPoint")
  .description("Watch Notation App")
  .action(async (entryPoint) => {
    await watch(entryPoint);
  });

program.parse(process.argv);
