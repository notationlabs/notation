import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { collectResourceGraph, declaredIn } from "@notation/resource";
import { $durableObject, $worker, isWorkerGroup, worker } from "src/workers";

const compatibilityDate = "2026-10-12";
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notation-worker-file-"));
  setConfigFile(path.join(root, "notation.config.ts"));
  fs.mkdirSync(path.join(root, "external"));
});

afterEach(() => {
  setConfigFile(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

function writeCode(source = "export default {};") {
  const file = "external/worker.mjs";
  fs.writeFileSync(path.join(root, file), source);
  return file;
}

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

describe("worker() with a prebuilt file", () => {
  it.each(["relative", "absolute"])(
    "tracks a %s path as a file in its group without adding a bundle",
    async (kind) => {
      const file = writeCode();
      const graph = await collect(() => {
        const external = worker({
          id: "external",
          code: {
            type: "file",
            path: kind === "absolute" ? path.join(root, file) : file,
          },
          compatibilityDate,
          bindings: () => ({ GREETING: "hello" }),
          compatibilityFlags: ["streams_enable_constructors"],
          url: false,
        });
        declaredIn(
          $worker({
            id: "api",
            compatibilityDate,
            bindings: () => ({ EXTERNAL: external }),
          }),
          "runtime/api.ts",
          "worker",
        );
      });
      const external = graph.resourceGroups.find(
        (group) => isWorkerGroup(group) && group.id === "external",
      );
      if (!isWorkerGroup(external)) throw new Error("No external Worker");

      expect(external.code.type).toBe("std/fs/File");
      expect(external.code.id).toBe("worker:external:code");
      expect(external.code.config).toEqual({ filePath: file });
      expect(external.resources).toContain(external.code);
      expect(external.script.dependencies.code).toBe(external.code);
      expect(external.script.config).toMatchObject({
        CompatibilityFlags: ["nodejs_compat", "streams_enable_constructors"],
        Bindings: [{ type: "plain_text", name: "GREETING", text: "hello" }],
      });
      expect(external.subdomain).toBeUndefined();
      expect(
        graph.resources.some((r) => r.type === "build/bundle/Bundle"),
      ).toBe(false);
      const api = graph.resourceGroups.find(
        (group) => isWorkerGroup(group) && group.id === "api",
      );
      if (!isWorkerGroup(api)) throw new Error("No api Worker");
      expect(api.script.getDependencies()).toContain(external.script);
    },
  );

  it("inspects exports without executing the file and hosts its namespace", async () => {
    const file = writeCode(`
      import { DurableObject } from "cloudflare:workers";
      throw new Error("must not execute");
      export class Room extends DurableObject {}
      export default {};
    `);
    const graph = await collect(() => {
      class Room {}
      const rooms = $durableObject({ id: "rooms", class: Room });
      worker({
        id: "external",
        code: { type: "file", path: file },
        compatibilityDate,
        bindings: () => ({ ROOMS: rooms }),
      });
    });
    const external = graph.resourceGroups.find(isWorkerGroup)!;
    expect(external.script.config.DurableObjectNamespaces).toEqual([
      { id: "rooms", className: "Room" },
    ]);
  });

  it("explains missing namespace exports, including export stars", async () => {
    const file = writeCode('export * from "./rooms.mjs"; export default {};');
    await expect(
      collect(() => {
        class Room {}
        const rooms = $durableObject({ id: "rooms", class: Room });
        worker({
          id: "external",
          code: { type: "file", path: file },
          compatibilityDate,
          bindings: () => ({ ROOMS: rooms }),
        });
      }),
    ).rejects.toThrow(
      `The code file of worker({ id: "external" }), ${file}, doesn't export Room, the class of $durableObject({ id: "rooms" }), which the Worker "external" binds as ROOMS. Export the class from the code file under that name, as Cloudflare finds the class by its export name, or from the module of another Worker that binds the namespace. The names that export * from "./rooms.mjs" brings in are not known when the bindings are resolved, so export Room by name.`,
    );
  });

  it("reports unreadable code files", () => {
    expect(() =>
      worker({
        id: "external",
        code: { type: "file", path: "missing.mjs" },
        compatibilityDate,
      }),
    ).toThrow(
      `worker({ id: "external" }) can't read its code file missing.mjs`,
    );
  });

  it.each([
    undefined,
    null,
    {},
    { type: "file" },
    { type: "file", path: "" },
    { type: "zip", path: "worker.zip" },
  ])("rejects invalid code %j", (code) => {
    expect(() =>
      worker({ id: "external", code: code as any, compatibilityDate }),
    ).toThrow('expects code to be { type: "file"');
  });

  it("rejects exports that workerd cannot start", () => {
    const file = writeCode('export const NAME = "invalid"; export default {};');
    expect(() =>
      worker({
        id: "external",
        code: { type: "file", path: file },
        compatibilityDate,
      }),
    ).toThrow("the module exports NAME, whose value is a primitive");
  });
});
