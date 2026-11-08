import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModuleAnalyses } from "src/index";
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
      "an infra module because it imports createQueue from @notation/aws/sqs",
    );
    expect(describe("runtime/fn.ts")).toBe(
      "a runtime module because it declares a function with $lambda",
    );
    expect(describe("shared/schema.ts")).toBeUndefined();
  });

  it("counts a factory that calls a resource function only inside a function as infra", () => {
    const { kind } = setup({
      "infra/factory.ts": `import { createQueue } from "@notation/aws/sqs";\nexport const makeQueue = (id) => createQueue({ id });`,
    });
    expect(kind("infra/factory.ts")).toBe("infra");
  });

  it("counts a barrel that re-exports infra as infra, and names the chain", () => {
    const { kind, describe } = setup({
      "infra/orders.ts": queueModule,
      "infra/index.ts": `export * from "./orders";`,
      "infra/named.ts": `export { orders } from "./index";`,
    });
    expect(kind("infra/index.ts")).toBe("infra");
    expect(describe("infra/named.ts")).toBe(
      "an infra module because it imports infra/index.ts, which imports infra/orders.ts, which imports createQueue from @notation/aws/sqs",
    );
  });

  it("counts a module that calls a factory from an infra module as infra", () => {
    const { describe } = setup({
      "infra/factory.ts": `import { createQueue } from "@notation/aws/sqs";\nexport const makeQueue = (id) => createQueue({ id });`,
      "infra/orders.ts": `import { makeQueue } from "./factory";\nexport const orders = makeQueue("orders");`,
    });
    expect(describe("infra/orders.ts")).toBe(
      "an infra module because it imports infra/factory.ts, which imports createQueue from @notation/aws/sqs",
    );
  });

  it("counts a module that imports infra only for its side effects as infra", () => {
    const { kind } = setup({
      "infra/orders.ts": queueModule,
      "infra/main.ts": `import "./orders";`,
    });
    expect(kind("infra/main.ts")).toBe("infra");
  });

  it("follows an import cycle", () => {
    const { kind } = setup({
      "infra/orders.ts": queueModule,
      "lib/a.ts": `import { b } from "./b";\nexport const a = () => b;`,
      "lib/b.ts": `import { a } from "./a";\nimport { orders } from "../infra/orders";\nexport const b = () => [a, orders];`,
    });
    expect(kind("lib/a.ts")).toBe("infra");
    expect(kind("lib/b.ts")).toBe("infra");
  });

  it("doesn't count a runtime module, or a module that imports one, as infra", () => {
    const { kind } = setup({
      "infra/orders.ts": `${queueModule}\nimport { lambda } from "../runtime/fn";`,
      "runtime/fn.ts": lambdaModule,
      "lib/route.ts": `import { lambda } from "../runtime/fn";\nexport const id = () => lambda.id;`,
    });
    expect(kind("runtime/fn.ts")).toBe("runtime");
    expect(kind("lib/route.ts")).toBe("shared");
  });

  it("ignores a type import of an infra module", () => {
    const { kind } = setup({
      "infra/orders.ts": queueModule,
      "lib/types.ts": `import type { orders } from "../infra/orders";\nimport { type orders as o } from "../infra/orders";\nexport type Q = typeof orders | typeof o;`,
    });
    expect(kind("lib/types.ts")).toBe("shared");
  });

  it("doesn't classify packages, or follow imports into them", () => {
    const { kind } = setup({
      "node_modules/helpers/index.js": `import { createQueue } from "@notation/aws/sqs";\nexport const label = "x";\nexport const make = () => createQueue({});`,
      "lib/label.ts": `import { label } from "helpers";\nexport const text = label;`,
    });
    expect(kind("node_modules/helpers/index.js")).toBeUndefined();
    expect(kind("lib/label.ts")).toBe("shared");
  });

  it("makes a module that sharedModules matches shared, and stops there", () => {
    const { kind } = setup(
      {
        "infra/orders.ts": queueModule,
        "shared/format.ts": `import { orders } from "../infra/orders";\nexport const format = () => orders;`,
        "lib/uses-format.ts": `import { format } from "../shared/format";\nexport const f = format;`,
      },
      ["shared/**"],
    );
    expect(kind("shared/format.ts")).toBe("shared");
    expect(kind("lib/uses-format.ts")).toBe("shared");
  });

  it("recomputes kinds after a module changes", () => {
    const { analyses, kind } = setup({
      "infra/orders.ts": queueModule,
      "lib/a.ts": `export const a = 1;`,
    });
    expect(kind("lib/a.ts")).toBe("shared");
    analyses.fromSource(
      path.join(root, "lib/a.ts"),
      `import { orders } from "../infra/orders";\nexport const a = orders;`,
    );
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
    "A shared module runs in both builds, so it can't declare a function or resources, or import an infra or runtime module.";

  it("fails for a listed module that imports infra, with the line and the chain", () => {
    const { checkShared } = setup(
      {
        ...files,
        "shared/format.ts": `import { Order } from "./schema";\nimport { orders } from "../infra/index";\nexport const format = () => [Order, orders];`,
      },
      ["shared/**"],
    );
    expect(checkShared("shared/format.ts")).toThrow(
      `shared/format.ts:2:1: shared/format.ts matches sharedModules, but it imports infra/index.ts, which is an infra module because it imports infra/orders.ts, which imports createQueue from @notation/aws/sqs. ${reason}`,
    );
  });

  it("fails for a listed module that imports a runtime module", () => {
    const { checkShared } = setup(
      {
        ...files,
        "shared/id.ts": `import { lambda } from "../runtime/fn";\nexport const id = () => lambda.id;`,
      },
      ["shared/*.ts"],
    );
    expect(checkShared("shared/id.ts")).toThrow(
      "shared/id.ts:1:1: shared/id.ts matches sharedModules, but it imports runtime/fn.ts, which is a runtime module because it declares a function with $lambda.",
    );
  });

  it("fails for a listed module that imports a resource function", () => {
    const { checkShared, kind } = setup(
      { ...files, "shared/queue.ts": queueModule },
      ["shared/**"],
    );
    expect(kind("shared/queue.ts")).toBe("shared");
    expect(checkShared("shared/queue.ts")).toThrow(
      "shared/queue.ts:1:10: shared/queue.ts matches sharedModules, but it imports the resource function createQueue from @notation/aws/sqs.",
    );
  });

  it("fails for a listed module with a declaration", () => {
    const { checkShared } = setup(files, ["runtime/**"]);
    expect(checkShared("runtime/fn.ts")).toThrow(
      "runtime/fn.ts:4:23: runtime/fn.ts matches sharedModules, but it declares a function with $lambda.",
    );
  });

  it("passes a listed module that imports shared modules and packages", () => {
    const { checkShared } = setup(
      {
        ...files,
        "shared/format.ts": `import { Order } from "./schema";\nimport { sqs } from "@notation/aws/lambda";\nexport const format = () => [Order, sqs];`,
      },
      ["shared/**"],
    );
    expect(checkShared("shared/format.ts")).not.toThrow();
  });

  it("doesn't check a module that sharedModules doesn't match", () => {
    const { checkShared, kind } = setup({
      ...files,
      "shared/format.ts": `import { orders } from "../infra/orders";\nexport const format = () => orders;`,
    });
    expect(checkShared("shared/format.ts")).not.toThrow();
    expect(kind("shared/format.ts")).toBe("infra");
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
