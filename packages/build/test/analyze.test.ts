import { describe, expect, it } from "vitest";
import { analyze, packageFiles, packages } from "./virtual";

const run = (source: string, extra: Record<string, string> = {}) =>
  analyze(
    { ...packageFiles, ...extra, "runtime/fn.ts": source },
    "runtime/fn.ts",
    packages,
  ).analysis;

describe("analyzeModule", () => {
  it("finds the declaration and its options", () => {
    const { declaration, isInfra } = run(`
      import { $lambda, sqs } from "@notation/aws/lambda";
      export const lambda = $lambda({ id: "fn", event: () => sqs(null), "env": () => ({}) });
    `);
    expect(isInfra).toBe(false);
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

  it("marks a module that calls a resource function at the top level as infra", () => {
    expect(
      run(
        `import { createQueue } from "@notation/aws/sqs";\nexport const q = createQueue({});`,
      ).isInfra,
    ).toBe(true);
    expect(
      run(
        `import { createQueue } from "@notation/aws/sqs";\nexport const q = () => createQueue({});`,
      ).isInfra,
    ).toBe(false);
  });

  it("ignores a name that shadows the import", () => {
    const { declaration } = run(
      `import { $lambda } from "@notation/aws/lambda";\nexport const f = ($lambda) => $lambda({});`,
    );
    expect(declaration).toBeUndefined();
  });
});
