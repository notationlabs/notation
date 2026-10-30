import path from "node:path";
import fse from "fs-extra";
import { execSync } from "node:child_process";
import whichPmRuns from "which-pm-runs";
import { setConfigApp, toNameSafe } from "./app-name";

const dirname = path.dirname(new URL(import.meta.url).pathname);
const packageManager = whichPmRuns()?.name || "npm";
const packageManagerInstallCommand = getPmInstallCommand(packageManager);

export async function scaffoldApp(appName: string) {
  const cwd = process.cwd();
  const appDir = path.join(cwd, appName);

  await fse.ensureDir(appDir);

  const children = await fse.readdir(appDir);

  if (children.length) {
    console.error(
      `Directory ${path.relative(process.cwd(), appDir)} is not empty`,
    );
    return;
  }

  console.log(`\nCreating app from template...`);

  const templateDir = path.join(dirname, "../templates/starter");

  await fse.copy(templateDir, appDir);

  const packageJsonPath = path.join(appDir, "package.json");
  const packageJsonContent = await fse.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonContent);

  packageJson.name = appName;
  const updatedPackageJson = JSON.stringify(packageJson, null, 2);

  await fse.writeFile(packageJsonPath, updatedPackageJson, {
    encoding: "utf8",
  });

  const configPath = path.join(appDir, "notation.config.ts");
  const config = await fse.readFile(configPath, "utf8");
  await fse.writeFile(configPath, setConfigApp(config, toNameSafe(appName)), {
    encoding: "utf8",
  });

  console.log(`Installing dependencies with ${packageManager}...`);

  execSync(
    `${packageManagerInstallCommand} @notation/cli @notation/aws @notation/core`,
    {
      cwd: appDir,
      stdio: "inherit",
    },
  );

  console.log("\nApp ready! To get started run:\n");
  console.log(`➜ cd ${appName}`);
  console.log(`➜ ${getPmRunCommand(packageManager)} viz`);
  console.log(`➜ ${getPmRunCommand(packageManager)} deploy`);
}

function getPmInstallCommand(pm: string) {
  switch (pm) {
    case "yarn":
      return "yarn add";
    case "pnpm":
      return "pnpm add";
    case "bun":
      return "bun add";
    default:
      return "npm install";
  }
}

function getPmRunCommand(pm: string) {
  switch (pm) {
    case "yarn":
      return "yarn";
    case "pnpm":
      return "pnpm";
    case "bun":
      return "bun";
    default:
      return "npm run";
  }
}
