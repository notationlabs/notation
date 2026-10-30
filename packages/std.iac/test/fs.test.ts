import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import * as durable from "@notation/reconciler/durable";
import type { BaseResource } from "@notation/resource";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { File, Zip } from "src/resources/fs";

let directory: string;
let runtime: NodeDurableRuntime;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-std-fs-"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "std", stage: "test", entry: "fs" },
    databasePath: path.join(directory, "workflows.db"),
  });
});

afterEach(async () => {
  runtime.close();
  await rm(directory, { recursive: true, force: true });
});

function deploy(
  resources: BaseResource[],
  executionId: string,
  driftDetection: boolean,
) {
  return runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, executionId) =>
      durable.deploy(step, {
        executionId,
        resources,
        state: runtime.state,
        driftDetection,
      }),
  );
}

async function sha256Base64(filePath: string) {
  const bytes = await readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("base64");
}

describe("fs resources in the durable reconciler", () => {
  it("records the SHA-256 of the archive that a Zip writes", async () => {
    const sourceFilePath = path.join(directory, "handler.js");
    await writeFile(sourceFilePath, "export const handler = () => 1;");

    await deploy(
      [new Zip("zip", { config: { sourceFilePath } })],
      "create",
      true,
    );

    const created = await runtime.state.get("zip");
    expect(created?.output.fileSha256).toBe(
      await sha256Base64(`${sourceFilePath}.zip`),
    );
    expect(created?.output).not.toHaveProperty("file");

    await deploy(
      [new Zip("zip", { config: { sourceFilePath } })],
      "redeploy",
      true,
    );

    expect(await runtime.state.get("zip")).toEqual(created);
  });

  it("records the SHA-256 of a File", async () => {
    const filePath = path.join(directory, "handler.zip");
    await writeFile(filePath, "zip bytes");

    await deploy([new File("file", { config: { filePath } })], "create", true);

    const created = await runtime.state.get("file");
    expect(created?.output.fileSha256).toBe(await sha256Base64(filePath));
    expect(created?.output).not.toHaveProperty("file");

    await deploy(
      [new File("file", { config: { filePath } })],
      "redeploy",
      true,
    );

    expect(await runtime.state.get("file")).toEqual(created);
  });
});
