import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMark } from "src/index";
import { root, virtualMarks } from "./virtual";

describe("parseMark", () => {
  it("reads a declaration mark", () => {
    expect(
      parseMark(
        "* @declaration shared: event, env; keys: env; entry: handler ",
        [],
        "f",
      ),
    ).toEqual({
      kind: "declaration",
      shared: ["event", "env"],
      runtime: [],
      keys: ["env"],
      entry: "handler",
    });
  });

  it("reads a declaration mark among other JSDoc", () => {
    const jsDoc =
      "*\n * Declares a namespace.\n * @declaration runtime: class\n * @param config the options\n ";
    expect(parseMark(jsDoc, [], "f")).toEqual({
      kind: "declaration",
      shared: [],
      runtime: ["class"],
      keys: [],
    });
  });

  it("reads the positions of a runtime mark's arguments", () => {
    expect(parseMark("* @runtime schema ", ["options", "schema"], "f")).toEqual(
      {
        kind: "runtime",
        positions: [1],
      },
    );
  });

  it("fails for a runtime mark that names a missing parameter", () => {
    expect(() => parseMark("* @runtime schema ", ["s"], "f.js")).toThrow(
      'f.js: the @runtime mark names the parameter "schema", which the function does not have',
    );
  });

  it("reads a resource mark", () => {
    expect(parseMark("* @resource ", [], "f")).toEqual({ kind: "resource" });
  });

  it("ignores JSDoc without a mark", () => {
    expect(parseMark("* Declares a queue. ", [], "f")).toBeUndefined();
  });
});

describe("Marks", () => {
  const lambda = `/** @declaration shared: event */\nexport function createLambda(config) {}\n`;
  const at = (file: string) => path.join(root, file);

  it("follows re-exports to the module that has the mark", () => {
    const marks = virtualMarks({
      "pkg/lambda.ts": lambda,
      "pkg/renamed.ts": `export { createLambda as declare } from "./lambda";`,
      "pkg/barrel.ts": `export * from "./renamed";`,
      "pkg/local.ts": `import { createLambda } from "./lambda";\nexport { createLambda };`,
    });
    expect(marks.exportMark(at("pkg/barrel.ts"), "declare")?.kind).toBe(
      "declaration",
    );
    expect(marks.exportMark(at("pkg/local.ts"), "createLambda")?.kind).toBe(
      "declaration",
    );
    expect(
      marks.exportMark(at("pkg/barrel.ts"), "createLambda"),
    ).toBeUndefined();
  });

  it("finds a mark on a function that is exported later under another name", () => {
    // The shape that tsdown emits for a shared chunk.
    const marks = virtualMarks({
      "dist/chunk.js": `/** @resource */\nconst createQueue = (config) => config;\nfunction other() {}\nexport { createQueue as n, other as o };`,
      "dist/sqs.js": `export { n as createQueue } from "./chunk.js";`,
    });
    expect(marks.exportMark(at("dist/sqs.js"), "createQueue")).toEqual({
      kind: "resource",
    });
    expect(marks.exportMark(at("dist/chunk.js"), "o")).toBeUndefined();
  });

  it("stops at an export cycle", () => {
    const marks = virtualMarks({
      "a.ts": `export * from "./b";`,
      "b.ts": `export * from "./a";`,
    });
    expect(marks.exportMark(at("a.ts"), "x")).toBeUndefined();
  });
});
