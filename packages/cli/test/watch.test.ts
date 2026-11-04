import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Deployment } from "@notation/core";

const { deployInChild } = vi.hoisted(() => ({
  deployInChild: vi.fn(),
}));

vi.mock("../src/compile", () => ({ compile: vi.fn(async () => undefined) }));
vi.mock("../src/deploy-child", () => ({ deployInChild }));

import { compile } from "../src/compile";
import { watch } from "../src/watch";

const deployment: Deployment = {
  app: "orders-app",
  stage: "dev",
  entryPoint: "infra/api.ts",
  runtimeModules: ["**/*.fn.ts"],
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let root: string;
const cwd = process.cwd();

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "notation-watch-")));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  process.chdir(root);
  deployInChild.mockReset();
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const changeConfig = () =>
  writeFileSync(path.join(root, "notation.config.ts"), "export default 1");

it("exits when notation.config.ts changes", async () => {
  deployInChild.mockResolvedValue(undefined);
  const exit = vi.fn();
  const log = logger();

  await watch(deployment, { logger: log, exit });
  changeConfig();

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(log.error).toHaveBeenCalledWith(
    "notation.config.ts changed. Restart watch to use the new config.",
  );
});

it("waits for a running deploy to finish before it exits", async () => {
  let finishDeploy!: () => void;
  deployInChild.mockReturnValue(
    new Promise<void>((resolve) => (finishDeploy = resolve)),
  );
  const exit = vi.fn();

  await watch(deployment, { logger: logger(), exit });
  await vi.waitFor(() => expect(deployInChild).toHaveBeenCalled(), {
    timeout: 2000,
  });
  changeConfig();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(exit).not.toHaveBeenCalled();

  finishDeploy();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(deployInChild).toHaveBeenCalledTimes(1);
});

it("doesn't deploy while a build failed, and deploys after the builds succeed", async () => {
  deployInChild.mockResolvedValue(undefined);
  let onBuildStatus!: (ok: boolean) => void;
  vi.mocked(compile).mockImplementationOnce(async (_deployment, opts) => {
    onBuildStatus = opts!.onBuildStatus!;
    onBuildStatus(false);
  });
  const log = logger();

  await watch(deployment, { logger: log, exit: vi.fn() });
  writeFileSync(path.join(root, "dist/infra.mjs"), "export {}");
  await vi.waitFor(() =>
    expect(log.info).toHaveBeenCalledWith(
      "A build failed, so watch didn't deploy. Watch deploys after the builds succeed.",
    ),
  );
  expect(deployInChild).not.toHaveBeenCalled();

  onBuildStatus(true);
  await vi.waitFor(() => expect(deployInChild).toHaveBeenCalledTimes(1));
});
