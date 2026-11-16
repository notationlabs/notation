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
    const { declaration, resourceCall } = run(`
      import { $lambda, sqs } from "@notation/aws/lambda";
      export const lambda = $lambda({ id: "fn", event: () => sqs.schema({}), "env": () => ({}) });
    `);
    expect(resourceCall).toBeUndefined();
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

  it("finds a call to a resource function at the top level", () => {
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

  it("ignores a name that shadows the import", () => {
    const { declaration } = run(
      `import { $lambda } from "@notation/aws/lambda";\nexport const f = ($lambda) => $lambda({});`,
    );
    expect(declaration).toBeUndefined();
  });
});

describe("the entryOption of a declaration", () => {
  const worker = `/** @declaration shared: id; runtime: entrypoint; entryOption: entrypoint; entry: default; platform: workerd */
export function $worker(config) { return config; }`;
  const runWorker = (source: string, extra: Record<string, string> = {}) =>
    analyze(
      {
        "pkg/workers.js": worker,
        "runtime/github-impl.ts": "export default class Github {}",
        ...extra,
        "runtime/github.ts": source,
      },
      "runtime/github.ts",
      { "@notation/cloudflare/workers": "pkg/workers.js" },
    ).analysis;
  const declare = (entrypoint: string) =>
    `import { $worker } from "@notation/cloudflare/workers";\n` +
    `export const github = $worker({ id: "github", entrypoint: ${entrypoint} });\n`;

  it.each([
    ["export default class Github {}", "a default-exported class"],
    ["class Github {}\nexport default Github;", "export default of a class"],
    ["class Github {}\nexport { Github as default };", "export as default"],
  ])("accepts %s (%s)", (classSource) => {
    const source = `${classSource}\n${declare("Github")}`;
    expect(runWorker(source).declaration?.binding).toBe("github");
  });

  it("accepts a declaration without the option", () => {
    const source = `import { $worker } from "@notation/cloudflare/workers";\nexport const github = $worker({ id: "github" });\nexport default {};`;
    expect(runWorker(source).declaration?.binding).toBe("github");
  });

  it.each([
    [
      "a class that isn't the default export",
      `export default class Github {}\nexport class Admin {}\n${declare("Admin")}`,
      "/project/runtime/github.ts:4:59: entrypoint must name the class that github.ts declares and exports as its default. Pass entrypoint: Github.",
    ],
    [
      "an imported class",
      `import Github from "./github-impl";\nexport default Github;\n${declare("Github")}`,
      "entrypoint is Github, which github.ts imports from ./github-impl. Declare it in github.ts and export it as its default.",
    ],
    [
      "a re-exported default",
      `export { default } from "./github-impl";\nclass Github {}\n${declare("Github")}`,
      "entrypoint must name a class that github.ts declares, but github.ts re-exports its default from ./github-impl.",
    ],
    [
      "an anonymous default export",
      `class Github {}\nexport default class {}\n${declare("Github")}`,
      "entrypoint must name the class that github.ts declares and exports as its default.",
    ],
    [
      "a value that isn't a name",
      `export default class Github {}\n${declare("class {}")}`,
      "entrypoint must name the class that github.ts declares and exports as its default. Pass entrypoint: Github.",
    ],
    [
      "a class declared after the declaration",
      `${declare("Github")}export default class Github {}`,
      "/project/runtime/github.ts:2:59: entrypoint is Github, which github.ts declares after $worker. Declare the class before $worker.",
    ],
  ])("fails for %s", (_, source, message) => {
    expect(() => runWorker(source)).toThrow(message);
  });
});

describe("ModuleAnalyses", () => {
  it("reuses the analysis of a source that hasn't changed", () => {
    const analyses = new ModuleAnalyses({
      marks: virtualMarks(packageFiles, packages),
    });
    const file = path.join(root, "runtime/fn.ts");
    const source = `export const a = 1;`;
    const first = analyses.fromSource(file, source);
    expect(analyses.fromSource(file, source)).toBe(first);
    expect(analyses.fromSource(file, `export const a = 2;`)).not.toBe(first);
  });
});
