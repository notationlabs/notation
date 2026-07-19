import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const originalWorkingDirectory = process.cwd();

afterEach(async () => {
  process.chdir(originalWorkingDirectory);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("reconciler example", () => {
  it("runs as a self-contained program", async () => {
    const workingDirectory = await mkdtemp(
      path.join(tmpdir(), "notation-reconciler-test-"),
    );
    directories.push(workingDirectory);
    process.chdir(workingDirectory);

    await import("../src/index");

    await expect(readFile("sites/docs/index.html", "utf8")).resolves.toBe(
      "<h1>Documentation</h1>\n",
    );
    await expect(readFile("sites/status/index.html", "utf8")).resolves.toBe(
      "<h1>All systems operational</h1>\n",
    );
    await expect(readFile("sites.db")).resolves.not.toHaveLength(0);
  });
});
