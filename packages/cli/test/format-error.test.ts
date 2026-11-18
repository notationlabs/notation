import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { formatError } from "../src/format-error";

const root = "/home/me/my app";

const withStack = (error: Error, frames: string[]) => {
  error.stack = [`${error.name}: ${error.message}`, ...frames].join("\n");
  return error;
};

describe("formatError", () => {
  it("keeps the frames of project files outside node_modules", () => {
    const error = withStack(new Error("deploy failed"), [
      "    at plan (file:///home/me/my%20app/node_modules/@notation/reconciler/dist/plan.js:12:1)",
      "    at defineBucket (file:///home/me/my%20app/infra.ts:4:3)",
      "    at /home/me/my app/stacks/api.ts:9:7",
      "    at createBucket (/opt/notation/packages/aws/src/bucket.ts:8:2)",
      "    at async Promise.all (index 0)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ]);

    expect(formatError(error, root)).toBe(
      [
        "Error: deploy failed",
        "    at defineBucket (file:///home/me/my%20app/infra.ts:4:3)",
        "    at /home/me/my app/stacks/api.ts:9:7",
      ].join("\n"),
    );
  });

  it("does not count a sibling directory with the same prefix", () => {
    const error = withStack(new Error("deploy failed"), [
      "    at defineBucket (/home/me/my app-old/infra.ts:4:3)",
    ]);

    expect(formatError(error, root)).toBe("Error: deploy failed");
  });

  it("prints the cause chain and the errors of an AggregateError", () => {
    const frame = "    at defineBucket (/home/me/my app/infra.ts:4:3)";
    const inner = withStack(new TypeError("bad name"), [frame]);
    const cause = withStack(
      new AggregateError([inner, "not an error"], "plan failed"),
      [],
    );
    const error = withStack(new Error("deploy failed", { cause }), [frame]);

    expect(formatError(error, root)).toBe(
      [
        "Error: deploy failed",
        frame,
        "Caused by: AggregateError: plan failed",
        "  TypeError: bad name",
        `  ${frame}`,
        "  'not an error'",
      ].join("\n"),
    );
  });

  it("stops at a cause chain that loops", () => {
    const error = withStack(new Error("deploy failed"), []);
    error.cause = error;

    expect(formatError(error, root)).toBe("Error: deploy failed");
  });

  it("prints a thrown value that is not an error", () => {
    expect(formatError({ code: 1 }, root)).toBe("{ code: 1 }");
  });

  describe("with a real stack", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "notation format "));
    const infraFile = path.join(dir, "infra.js");
    writeFileSync(
      infraFile,
      'export function deploy() {\n  throw new Error("bucket failed");\n}\n',
    );
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("keeps the frame of the project file", async () => {
      const { deploy } = await import(pathToFileURL(infraFile).href);
      let error: unknown;
      try {
        deploy();
      } catch (caught) {
        error = caught;
      }

      const lines = formatError(error, dir).split("\n");

      expect(lines[0]).toBe("Error: bucket failed");
      expect(lines.slice(1)).toEqual([
        expect.stringMatching(/^\s+at deploy \(.*infra\.js:2:9\)$/),
      ]);
    });
  });
});
