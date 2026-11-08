import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModuleAnalyses } from "src/index";
import { displayPath } from "src/modules";
import { packageFiles, packages, root, virtualMarks } from "./virtual";

const queueModule = `import { createQueue } from "@notation/aws/sqs";\nexport const orders = createQueue({ id: "orders" });`;

const lambdaModule = `
import { $lambda } from "@notation/aws/lambda";
import { orders } from "../infra/orders";
export const lambda = $lambda({ id: "fn", env: () => ({ URL: orders.url }) });
export const handler = () => {};
`;

function setup(files: Record<string, string>, sharedModules: string[] = []) {
  const analyses = new ModuleAnalyses({
    marks: virtualMarks({ ...packageFiles, ...files }, packages),
    sharedModules,
    root,
  });
  const abs = (file: string) => path.join(root, file);
  return {
    analyses,
    kind: (file: string) => analyses.kind(abs(file))?.kind,
    describe: (file: string) => analyses.describeKind(abs(file)),
    checkShared: (file: string) => () => analyses.checkShared(abs(file)),
  };
}

describe("ModuleAnalyses.kind", () => {
  it("classifies runtime, infra and shared modules", () => {
    const { kind, describe } = setup({
      "infra/orders.ts": queueModule,
      "runtime/fn.ts": lambdaModule,
      "shared/schema.ts": `export const Order = {};`,
    });
    expect(kind("runtime/fn.ts")).toBe("runtime");
    expect(kind("infra/orders.ts")).toBe("infra");
    expect(kind("shared/schema.ts")).toBe("shared");
    expect(describe("infra/orders.ts")).toBe(
      "an infra module because it calls createQueue at its top level (infra/orders.ts:2:23)",
    );
    expect(describe("runtime/fn.ts")).toBe(
      "a runtime module because it declares a function with $lambda",
    );
    expect(describe("shared/schema.ts")).toBeUndefined();
  });

  it("doesn't count a factory that calls a resource function only inside a function as infra", () => {
    const { kind } = setup({
      "lib/factory.ts": `import { createQueue } from "@notation/aws/sqs";\nexport const makeQueue = (id) => createQueue({ id });`,
    });
    expect(kind("lib/factory.ts")).toBe("shared");
  });

  it("doesn't count a module that imports or re-exports infra as infra", () => {
    const { kind } = setup({
      "infra/orders.ts": queueModule,
      "infra/index.ts": `export * from "./orders";`,
      "lib/url.ts": `import { orders } from "../infra/orders";\nexport const url = () => orders.url;`,
      "lib/setup.ts": `import "../infra/orders";`,
    });
    expect(kind("infra/index.ts")).toBe("shared");
    expect(kind("lib/url.ts")).toBe("shared");
    expect(kind("lib/setup.ts")).toBe("shared");
  });

  it("names a resource function that a module calls by its exported name, not its alias", () => {
    const { describe } = setup({
      "infra/alias.ts": `import { createQueue as make } from "@notation/aws/sqs";\nexport const q = make({});`,
    });
    expect(describe("infra/alias.ts")).toBe(
      "an infra module because it calls createQueue at its top level (infra/alias.ts:2:18)",
    );
  });

  it("counts a module with a declaration as runtime, even if it calls a resource function", () => {
    const { kind } = setup({
      "runtime/fn.ts": `${lambdaModule}\nimport { createQueue } from "@notation/aws/sqs";\nexport const dlq = createQueue({});`,
      "infra/orders.ts": queueModule,
    });
    expect(kind("runtime/fn.ts")).toBe("runtime");
  });

  it("doesn't classify files in node_modules", () => {
    const { kind } = setup({
      "node_modules/helpers/index.js": `import { createQueue } from "@notation/aws/sqs";\nexport const q = createQueue({});`,
    });
    expect(kind("node_modules/helpers/index.js")).toBeUndefined();
  });

  it("recomputes a kind after its module changes", () => {
    const { analyses, kind } = setup({ "lib/a.ts": `export const a = 1;` });
    expect(kind("lib/a.ts")).toBe("shared");
    analyses.fromSource(path.join(root, "lib/a.ts"), queueModule);
    expect(kind("lib/a.ts")).toBe("infra");
  });
});

describe("ModuleAnalyses.checkShared", () => {
  const files = {
    "infra/orders.ts": queueModule,
    "infra/index.ts": `export * from "./orders";`,
    "runtime/fn.ts": lambdaModule,
    "shared/schema.ts": `export const Order = {};`,
  };
  const reason =
    "A shared module runs in both builds, so it can't declare a function or import a resource function, directly or through the modules that it imports.";
  const check = (extra: Record<string, string>, globs = ["shared/**"]) =>
    setup({ ...files, ...extra }, globs).checkShared;

  it("fails for a listed module that imports infra, with the line and the chain", () => {
    const checkShared = check({
      "shared/format.ts": `import { Order } from "./schema";\nimport { orders } from "../infra/index";\nexport const format = () => [Order, orders];`,
    });
    expect(checkShared("shared/format.ts")).toThrow(
      `shared/format.ts:2:1: shared/format.ts matches sharedModules, but it imports infra/index.ts, which imports infra/orders.ts (infra/index.ts:1:1), which imports the resource function createQueue from @notation/aws/sqs (infra/orders.ts:1:10). ${reason}`,
    );
  });

  it("fails for a listed module that imports infra through an unlisted module", () => {
    const checkShared = check({
      "lib/url.ts": `import { orders } from "../infra/orders";\nexport const url = () => orders.url;`,
      "shared/format.ts": `import { url } from "../lib/url";\nexport const format = () => url();`,
    });
    expect(checkShared("shared/format.ts")).toThrow(
      "shared/format.ts:1:1: shared/format.ts matches sharedModules, but it imports lib/url.ts, which imports infra/orders.ts (lib/url.ts:1:1), which imports the resource function createQueue from @notation/aws/sqs (infra/orders.ts:1:10).",
    );
  });

  it("fails for a listed module that imports a module with a resource function that it doesn't call at its top level", () => {
    const checkShared = check({
      "lib/factory.ts": `import { createQueue } from "@notation/aws/sqs";\nexport const makeQueue = (id) => createQueue({ id });`,
      "shared/format.ts": `import { makeQueue } from "../lib/factory";\nexport const format = () => makeQueue;`,
    });
    expect(checkShared("shared/format.ts")).toThrow(
      "shared/format.ts:1:1: shared/format.ts matches sharedModules, but it imports lib/factory.ts, which imports the resource function createQueue from @notation/aws/sqs (lib/factory.ts:1:10).",
    );
  });

  it("fails for a listed module that imports a runtime module", () => {
    const checkShared = check(
      {
        "shared/id.ts": `import { lambda } from "../runtime/fn";\nexport const id = () => lambda.id;`,
      },
      ["shared/*.ts"],
    );
    expect(checkShared("shared/id.ts")).toThrow(
      "shared/id.ts:1:1: shared/id.ts matches sharedModules, but it imports runtime/fn.ts, which declares a function with $lambda (runtime/fn.ts:4:23).",
    );
  });

  it("fails for a listed module that imports a resource function", () => {
    const checkShared = check({ "shared/queue.ts": queueModule });
    expect(checkShared("shared/queue.ts")).toThrow(
      "shared/queue.ts:1:10: shared/queue.ts matches sharedModules, but it imports the resource function createQueue from @notation/aws/sqs.",
    );
  });

  it("names a resource function by its exported name, not its alias", () => {
    const checkShared = check({
      "shared/alias.ts": `import { createQueue as make } from "@notation/aws/sqs";\nexport const q = () => make({});`,
    });
    expect(checkShared("shared/alias.ts")).toThrow(
      "shared/alias.ts:1:10: shared/alias.ts matches sharedModules, but it imports the resource function createQueue from @notation/aws/sqs.",
    );
  });

  it("fails for a listed module that re-exports all of a package with resource functions", () => {
    const checkShared = check({
      "shared/aws.ts": `export * from "@notation/aws/sqs";`,
    });
    expect(checkShared("shared/aws.ts")).toThrow(
      "shared/aws.ts:1:1: shared/aws.ts matches sharedModules, but it imports the resource function createQueue from @notation/aws/sqs.",
    );
  });

  it("fails for a listed module that uses a namespace import of a package with resource functions", () => {
    const checkShared = check({
      "shared/aws.ts": `import * as sqs from "@notation/aws/sqs";\nexport const all = () => sqs;`,
    });
    expect(checkShared("shared/aws.ts")).toThrow(
      "shared/aws.ts:1:8: shared/aws.ts matches sharedModules, but it imports the resource function createQueue from @notation/aws/sqs.",
    );
  });

  it("fails for a listed module that loads infra through an empty re-export", () => {
    const checkShared = check({
      "shared/load.ts": `export {} from "../infra/orders";`,
    });
    expect(checkShared("shared/load.ts")).toThrow(
      "shared/load.ts:1:1: shared/load.ts matches sharedModules, but it imports infra/orders.ts",
    );
  });

  it.each([
    [
      "a type import",
      `import type { orders } from "../infra/orders";\nimport { type orders as o } from "../infra/orders";\nexport type Q = typeof orders | typeof o;`,
    ],
    [
      "an import used only in typeof",
      `import { orders } from "../infra/orders";\nexport type Q = typeof orders;\nexport const format = (q: Q) => String(q);`,
    ],
    [
      "an import of an interface without the type keyword",
      `import { OrderMsg } from "../infra/types";\nexport const format = (m: OrderMsg): string => m.id;`,
    ],
    [
      "a resource function used only in types",
      `import { createQueue } from "@notation/aws/sqs";\nexport type Q = ReturnType<typeof createQueue>;`,
    ],
  ])("passes a listed module with %s", (_, source) => {
    const checkShared = check({
      "infra/types.ts": `import { createQueue } from "@notation/aws/sqs";\nexport interface OrderMsg { id: string }\nexport const q = createQueue({});`,
      "shared/format.ts": source,
    });
    expect(checkShared("shared/format.ts")).not.toThrow();
  });

  it("counts an import that is used only as a JSX element", () => {
    const checkShared = check({
      "lib/view.ts": `import { orders } from "../infra/orders";\nexport const View = () => orders;`,
      "shared/page.tsx": `import { View } from "../lib/view";\nexport const Page = () => <View />;`,
    });
    expect(checkShared("shared/page.tsx")).toThrow(
      "shared/page.tsx:1:1: shared/page.tsx matches sharedModules, but it imports lib/view.ts",
    );
  });

  it("ignores an import whose name is used only as a lowercase JSX tag", () => {
    const checkShared = check({
      "shared/view.tsx": `import { orders } from "../infra/orders";\nexport const View = () => <orders />;`,
    });
    expect(checkShared("shared/view.tsx")).not.toThrow();
  });

  it("counts an import that is used as the object of a JSX member tag", () => {
    const checkShared = check({
      "shared/view.tsx": `import { orders } from "../infra/orders";\nexport const View = () => <orders.View />;`,
    });
    expect(checkShared("shared/view.tsx")).toThrow(
      "shared/view.tsx:1:1: shared/view.tsx matches sharedModules, but it imports infra/orders.ts",
    );
  });

  it("names the first problem in the module", () => {
    const checkShared = check({
      "shared/format.ts": `import { orders } from "../infra/orders";\nimport { createQueue } from "@notation/aws/sqs";\nexport const format = () => [orders, createQueue];`,
    });
    expect(checkShared("shared/format.ts")).toThrow(
      "shared/format.ts:1:1: shared/format.ts matches sharedModules, but it imports infra/orders.ts",
    );
  });

  it("names a shortest chain", () => {
    const checkShared = check({
      "lib/c.ts": `import { orders } from "../infra/orders";\nexport const c = () => orders;`,
      "lib/b.ts": `import { c } from "./c";\nexport const b = () => c;`,
      "lib/a.ts": `import { b } from "./b";\nexport const a = () => b;`,
      "lib/x.ts": `import { a } from "./a";\nimport { orders } from "../infra/orders";\nexport const x = () => [a, orders];`,
      "shared/format.ts": `import { x } from "../lib/x";\nexport const format = () => x;`,
    });
    expect(checkShared("shared/format.ts")).toThrow(
      "but it imports lib/x.ts, which imports infra/orders.ts (lib/x.ts:2:1), which imports the resource function",
    );
  });

  it("follows an import cycle", () => {
    const checkShared = check({
      "shared/a.ts": `import { b } from "./b";\nexport const a = () => b;`,
      "shared/b.ts": `import { a } from "./a";\nimport { orders } from "../infra/orders";\nexport const b = () => [a, orders];`,
    });
    expect(checkShared("shared/a.ts")).toThrow(
      "but it imports shared/b.ts, which imports infra/orders.ts (shared/b.ts:2:1)",
    );
  });

  it("fails for a listed module with a declaration", () => {
    const checkShared = check({}, ["runtime/**"]);
    expect(checkShared("runtime/fn.ts")).toThrow(
      "runtime/fn.ts:4:23: runtime/fn.ts matches sharedModules, but it declares a function with $lambda.",
    );
  });

  it("passes a listed module that imports shared modules and packages", () => {
    const checkShared = check({
      "node_modules/helpers/index.js": `import { createQueue } from "@notation/aws/sqs";\nexport const label = "x";\nexport const make = () => createQueue({});`,
      "shared/format.ts": `import { Order } from "./schema";\nimport { sqs } from "@notation/aws/lambda";\nimport { label } from "helpers";\nexport const format = () => [Order, sqs, label];`,
    });
    expect(checkShared("shared/format.ts")).not.toThrow();
  });

  it("accepts a sharedModules glob with a leading ./", () => {
    const { analyses, checkShared } = setup(
      { ...files, "shared/queue.ts": queueModule },
      ["./shared/**"],
    );
    expect(analyses.isListedShared(path.join(root, "shared/queue.ts"))).toBe(
      true,
    );
    expect(checkShared("shared/queue.ts")).toThrow("matches sharedModules");
  });

  it("doesn't check a module that sharedModules doesn't match", () => {
    const checkShared = check(
      {
        "shared/format.ts": `import { orders } from "../infra/orders";\nexport const format = () => orders;`,
      },
      [],
    );
    expect(checkShared("shared/format.ts")).not.toThrow();
  });
});

describe("ModuleAnalyses.isProjectModule", () => {
  it("leaves out files in node_modules and in other named packages", () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "notation-")),
    );
    const write = (file: string, contents: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), contents);
    };
    try {
      write("package.json", JSON.stringify({ name: "monorepo" }));
      write("packages/aws/package.json", JSON.stringify({ name: "@x/aws" }));
      write("apps/api/package.json", JSON.stringify({ name: "api" }));
      write("apps/api/infra/package.json", JSON.stringify({ type: "module" }));
      const analyses = new ModuleAnalyses({ root: path.join(dir, "apps/api") });
      const isProject = (file: string) =>
        analyses.isProjectModule(path.join(dir, file));
      expect(isProject("apps/api/runtime/fn.ts")).toBe(true);
      expect(isProject("apps/api/infra/orders.ts")).toBe(true);
      expect(isProject("common/schema.ts")).toBe(true);
      expect(isProject("packages/aws/dist/sqs/index.js")).toBe(false);
      expect(isProject("apps/api/node_modules/x/index.js")).toBe(false);
      const root = path.join(dir, "apps/api");
      expect(displayPath(path.join(dir, "common/schema.ts"), root)).toBe(
        "../../common/schema.ts",
      );
      expect(
        displayPath(path.join(dir, "packages/aws/dist/sqs/index.js"), root),
      ).toBe("@x/aws/dist/sqs/index.js");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts files under the root as project modules, even in a named package", () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "notation-")),
    );
    const write = (file: string, contents: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), contents);
    };
    try {
      write("package.json", JSON.stringify({ name: "monorepo" }));
      write("packages/api/package.json", JSON.stringify({ name: "@acme/api" }));
      const analyses = new ModuleAnalyses({ root: dir });
      const isProject = (file: string) =>
        analyses.isProjectModule(path.join(dir, file));
      expect(isProject("packages/api/handler.ts")).toBe(true);
      expect(isProject("infra/orders.ts")).toBe(true);
      expect(isProject("node_modules/@acme/api/handler.js")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
