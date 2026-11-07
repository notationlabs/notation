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
      import { createLambda, sqs } from "@notation/aws/lambda";
      export const lambda = createLambda({ id: "fn", event: () => sqs(null), "env": () => ({}) });
    `);
    expect(isInfra).toBe(false);
    expect(declaration?.binding).toBe("lambda");
    expect(declaration?.name).toBe("createLambda");
    expect([...declaration!.properties.keys()]).toEqual(["id", "event", "env"]);
  });

  it.each([
    [
      "an aliased import",
      `import { createLambda as declare } from "@notation/aws/lambda";\nconst l = declare({});`,
    ],
    [
      "a namespace import",
      `import * as aws from "@notation/aws/lambda";\nconst l = aws.createLambda({});`,
    ],
    [
      "a barrel",
      `import { createLambda } from "./barrel";\nconst l = createLambda({});`,
    ],
    [
      "a marked wrapper",
      `import { createLambda } from "@notation/aws/lambda";\n/** @declaration shared: event */\nexport function myLambda(config) { return createLambda({ ...config }); }\nconst l = myLambda({});`,
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
      `import { createLambda } from "@notation/aws/lambda";\nexport const wrap = (c) => createLambda(c);`,
      "3:28: createLambda is called in an unsupported place",
    ],
    [
      "a positional argument",
      `import { createLambda } from "@notation/aws/lambda";\nconst l = createLambda("id", {});`,
      "3:11: createLambda takes one object literal of options",
    ],
    [
      "a default export",
      `import { createLambda } from "@notation/aws/lambda";\nexport default createLambda({});`,
      "3:16: createLambda is called in an unsupported place",
    ],
    [
      "a conditional declaration",
      `import { createLambda } from "@notation/aws/lambda";\nconst l = process.env.X ? createLambda({}) : undefined;`,
      "createLambda is called in an unsupported place",
    ],
    [
      "a reference that isn't a call",
      `import { createLambda } from "@notation/aws/lambda";\nexport const declare = createLambda;`,
      "createLambda can only be called",
    ],
    [
      "spread options",
      `import { createLambda } from "@notation/aws/lambda";\nconst base = {};\nconst l = createLambda({ ...base });`,
      "the options of createLambda can't use spread, computed keys or accessors",
    ],
    [
      "two declarations",
      `import { createLambda } from "@notation/aws/lambda";\nconst a = createLambda({});\nconst b = createLambda({});`,
      "the module has more than one declaration (createLambda at 3:11, createLambda at 4:11)",
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
      `import { createLambda } from "@notation/aws/lambda";\nexport const f = (createLambda) => createLambda({});`,
    );
    expect(declaration).toBeUndefined();
  });
});
