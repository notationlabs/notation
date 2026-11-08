import { describe, expect, it } from "vitest";
import path from "node:path";
import { ModuleAnalyses } from "src/index";
import { analyze, packageFiles, packages, root, virtualMarks } from "./virtual";

const run = (source: string, extra: Record<string, string> = {}) =>
  analyze(
    { ...packageFiles, ...extra, "runtime/fn.ts": source },
    "runtime/fn.ts",
    packages,
  ).analysis;

describe("analyzeModule", () => {
  it("finds the declaration and its options", () => {
    const { declaration, resource } = run(`
      import { $lambda, sqs } from "@notation/aws/lambda";
      export const lambda = $lambda({ id: "fn", event: () => sqs(null), "env": () => ({}) });
    `);
    expect(resource).toBeUndefined();
    expect(declaration?.binding).toBe("lambda");
    expect(declaration?.name).toBe("$lambda");
    expect([...declaration!.properties.keys()]).toEqual(["id", "event", "env"]);
  });

  it.each([
    [
      "an aliased import",
      `import { $lambda as declare } from "@notation/aws/lambda";\nconst l = declare({});`,
    ],
    [
      "a namespace import",
      `import * as aws from "@notation/aws/lambda";\nconst l = aws.$lambda({});`,
    ],
    ["a barrel", `import { $lambda } from "./barrel";\nconst l = $lambda({});`],
    [
      "a marked wrapper",
      `import { $lambda } from "@notation/aws/lambda";\n/** @declaration shared: event */\nexport function myLambda(config) { return $lambda({ ...config }); }\nconst l = myLambda({});`,
    ],
    [
      "satisfies",
      `import { $lambda } from "@notation/aws/lambda";\nconst l = $lambda({}) satisfies object;`,
    ],
    [
      "as const and parentheses",
      `import { $lambda } from "@notation/aws/lambda";\nconst l = ($lambda({}) as const);`,
    ],
  ])("finds a declaration through %s", (_, source) => {
    const { declaration } = run(source, {
      "runtime/barrel.ts": `export * from "@notation/aws/lambda";`,
    });
    expect(declaration?.binding).toBe("l");
  });

  it.each([
    [
      "an unmarked wrapper",
      `import { $lambda } from "@notation/aws/lambda";\nexport const wrap = (c) => $lambda(c);`,
      "3:28: $lambda is called in an unsupported place",
    ],
    [
      "a positional argument",
      `import { $lambda } from "@notation/aws/lambda";\nconst l = $lambda("id", {});`,
      "3:11: $lambda takes one object literal of options",
    ],
    [
      "a default export",
      `import { $lambda } from "@notation/aws/lambda";\nexport default $lambda({});`,
      "3:16: $lambda is called in an unsupported place",
    ],
    [
      "a conditional declaration",
      `import { $lambda } from "@notation/aws/lambda";\nconst l = process.env.X ? $lambda({}) : undefined;`,
      "$lambda is called in an unsupported place",
    ],
    [
      "a reference that isn't a call",
      `import { $lambda } from "@notation/aws/lambda";\nexport const declare = $lambda;`,
      "$lambda can only be called",
    ],
    [
      "spread options",
      `import { $lambda } from "@notation/aws/lambda";\nconst base = {};\nconst l = $lambda({ ...base });`,
      "the options of $lambda can't use spread, computed keys or accessors",
    ],
    [
      "two declarations",
      `import { $lambda } from "@notation/aws/lambda";\nconst a = $lambda({});\nconst b = $lambda({});`,
      "the module has more than one declaration ($lambda at 3:11, $lambda at 4:11)",
    ],
  ])("fails for %s", (_, source, message) => {
    expect(() => run(`\n${source}`)).toThrow(message);
  });

  it.each([
    [
      "calls it at the top level",
      `import { createQueue } from "@notation/aws/sqs";\nexport const q = createQueue({});`,
      "createQueue",
    ],
    [
      "calls it only inside a function",
      `import { createQueue } from "@notation/aws/sqs";\nexport const q = () => createQueue({});`,
      "createQueue",
    ],
    [
      "doesn't call it",
      `import { createQueue as make } from "@notation/aws/sqs";\nexport const q = () => make({});`,
      "createQueue",
    ],
    [
      "uses a namespace import as a value",
      `import * as sqs from "@notation/aws/sqs";\nexport const all = () => sqs;`,
      "createQueue",
    ],
    [
      "uses it through a namespace",
      `import * as sqs from "@notation/aws/sqs";\nexport const q = () => sqs.createQueue({});`,
      "sqs.createQueue",
    ],
    [
      "re-exports it",
      `export { createQueue } from "@notation/aws/sqs";`,
      "createQueue",
    ],
  ])("records the resource function of a module that %s", (_, source, name) => {
    expect(run(source).resource).toMatchObject({
      name,
      source: "@notation/aws/sqs",
    });
  });

  it("records a call to a resource function at the top level only", () => {
    expect(
      run(
        `import { createQueue } from "@notation/aws/sqs";\nexport const q = createQueue({});`,
      ).resourceCall?.name,
    ).toBe("createQueue");
    expect(
      run(
        `import { createQueue } from "@notation/aws/sqs";\nexport const q = () => createQueue({});`,
      ).resourceCall,
    ).toBeUndefined();
  });

  it("records no resource function for a type import", () => {
    expect(
      run(`import type { createQueue } from "@notation/aws/sqs";`).resource,
    ).toBeUndefined();
  });

  it("ignores a name that shadows the import", () => {
    const { declaration } = run(
      `import { $lambda } from "@notation/aws/lambda";\nexport const f = ($lambda) => $lambda({});`,
    );
    expect(declaration).toBeUndefined();
  });
});

describe("ModuleAnalyses", () => {
  it("reuses the analysis of a source that hasn't changed", () => {
    const analyses = new ModuleAnalyses({
      marks: virtualMarks(packageFiles, packages),
      root,
    });
    const file = path.join(root, "runtime/fn.ts");
    const source = `export const a = 1;`;
    const first = analyses.fromSource(file, source);
    expect(analyses.fromSource(file, source)).toBe(first);
    expect(analyses.fromSource(file, `export const a = 2;`)).not.toBe(first);
  });
});
