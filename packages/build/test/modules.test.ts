import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModuleGlobs } from "@notation/core";
import { FileKinds, ModuleAnalyses } from "src/index";
import { packageFiles, packages, root, virtualMarks } from "./virtual";

const abs = (file: string) => path.join(root, file);
const kind = (globs: ModuleGlobs, file: string) =>
  new FileKinds(globs, root).kindOf(abs(file));

describe("FileKinds", () => {
  it("gives each default folder its kind", () => {
    expect(kind({}, "infra/orders.ts")).toEqual({
      kind: "infra",
      glob: "infra/**",
      isDefault: true,
    });
    expect(kind({}, "runtime/jobs/send.tsx")?.kind).toBe("runtime");
    expect(kind({}, "shared/schema.mjs")?.kind).toBe("shared");
    expect(kind({}, "lib/format.ts")).toBeUndefined();
    expect(kind({}, "index.ts")).toBeUndefined();
  });

  it("replaces only the default of the kind that the config sets", () => {
    const globs = { shared: ["lib/**"] };
    expect(kind(globs, "lib/format.ts")).toEqual({
      kind: "shared",
      glob: "lib/**",
      isDefault: false,
    });
    expect(kind(globs, "shared/schema.ts")).toBeUndefined();
    expect(kind(globs, "infra/orders.ts")?.kind).toBe("infra");
    expect(kind(globs, "runtime/fn.ts")?.kind).toBe("runtime");
  });

  it("gives no file a kind that is set to no globs", () => {
    expect(kind({ shared: [] }, "shared/schema.ts")).toBeUndefined();
  });

  it("accepts a leading ./, and quotes the glob as the config writes it", () => {
    expect(kind({ runtime: ["./functions/*.ts"] }, "functions/a.ts")).toEqual({
      kind: "runtime",
      glob: "./functions/*.ts",
      isDefault: false,
    });
  });

  it.each([["infra"], ["infra/"], ["./infra"]])(
    "reads %j as the files in the folder",
    (glob) => {
      expect(kind({ infra: [glob] }, "infra/a/b.ts")).toEqual({
        kind: "infra",
        glob,
        isDefault: false,
      });
    },
  );

  it("reads a glob with no glob characters as a file or a folder", () => {
    const globs = { shared: ["lib/format.ts", "lib/schema"] };
    expect(kind(globs, "lib/format.ts")?.kind).toBe("shared");
    expect(kind(globs, "lib/schema/order.ts")?.kind).toBe("shared");
    expect(kind(globs, "lib/schemas/order.ts")).toBeUndefined();
    expect(kind(globs, "lib/other.ts")).toBeUndefined();
  });

  it.each([["packages/@acme/infra"], ["app/(infra)"], ["c++"]])(
    "reads %j as a folder",
    (glob) => {
      expect(kind({ infra: [glob] }, `${glob}/a.ts`)?.kind).toBe("infra");
    },
  );

  it("lists the files of a folder that is created after the globs are read", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "notation-kinds-"));
    try {
      const files = new FileKinds({ runtime: ["jobs"] }, dir);
      expect(files.list("runtime")).toEqual([]);
      mkdirSync(path.join(dir, "jobs"));
      writeFileSync(path.join(dir, "jobs/a.ts"), "");
      const file = path.join(files.root, "jobs/a.ts");
      expect(files.kindOf(file)?.kind).toBe("runtime");
      expect(files.list("runtime")).toEqual([file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out the files that a glob with ! matches", () => {
    const globs = { infra: ["infra/**", "!infra/**/*.test.ts"] };
    expect(kind(globs, "infra/orders.ts")?.kind).toBe("infra");
    expect(kind(globs, "infra/orders.test.ts")).toBeUndefined();
    expect(kind(globs, "infra/deep/orders.test.ts")).toBeUndefined();
  });

  it("gives no kind to files outside the root, in node_modules or in dist", () => {
    const globs = { shared: ["**"] };
    expect(kind(globs, "../other/infra.ts")).toBeUndefined();
    expect(kind(globs, "node_modules/pkg/index.js")).toBeUndefined();
    expect(kind(globs, "infra/dist/orders.js")).toBeUndefined();
    expect(kind(globs, ".notation/state.ts")).toBeUndefined();
  });

  it("fails for a file that two kinds match, and names both globs", () => {
    expect(() =>
      kind({ infra: ["src/**"], shared: ["src/shared/**"] }, "src/shared/a.ts"),
    ).toThrow(
      'src/shared/a.ts matches both files.infra and files.shared (files.infra: "src/**"; files.shared: "src/shared/**"). A file can have only one kind.',
    );
  });

  it("says which glob is a default when two kinds match a file", () => {
    expect(() => kind({ infra: ["**/*.ts"] }, "shared/a.ts")).toThrow(
      'shared/a.ts matches both files.infra and files.shared (files.infra: "**/*.ts"; files.shared: "shared/**", the default). A file can have only one kind. Change the globs so that only one of them matches it. files.shared isn\'t set in the config, so it has its default globs. Set it to replace them, or set it to [] for no shared modules.',
    );
  });

  it("treats a file outside the root or in node_modules as a package file", () => {
    const files = new FileKinds({}, root);
    expect(files.isPackageFile(abs("infra/orders.ts"))).toBe(false);
    expect(files.isPackageFile(abs("../acme-lib/index.ts"))).toBe(true);
    expect(files.isPackageFile(abs("node_modules/acme/index.js"))).toBe(true);
  });
});

const sqs = `import { createQueue } from "@notation/aws/sqs";`;

function check(
  files: Record<string, string>,
  file = "shared/schema.ts",
  globs: ModuleGlobs = {},
) {
  const analyses = new ModuleAnalyses({
    marks: virtualMarks({ ...packageFiles, ...files }, packages),
    files: globs,
    root,
  });
  return () => analyses.checkShared(abs(file));
}

const orders = `${sqs}\nexport const orders = createQueue({});\nexport type Order = {};`;

describe("checkShared", () => {
  it("passes for a module that imports only shared modules and packages", () => {
    check({
      "shared/schema.ts": `import { format } from "../lib/format";\nimport { x } from "valibot";\nexport const Order = format(x);`,
      "lib/format.ts": `import { trim } from "./trim";\nexport const format = trim;`,
      "lib/trim.ts": `export const trim = (s) => s;`,
    })();
  });

  it("fails for a declaration", () => {
    expect(
      check({
        "shared/schema.ts": `import { $lambda } from "@notation/aws/lambda";\nexport const lambda = $lambda({ id: "fn" });`,
      }),
    ).toThrow(
      'shared/schema.ts:2:23: $lambda() can\'t be used in shared/schema.ts, a shared module (files.shared: "shared/**", the default), because a shared module runs as written both at deploy and in the function, and only a runtime module can hold a declaration: at deploy, only the declaration of a runtime module runs. Move the declaration to a runtime module.',
    );
  });

  it.each([
    [
      "a named import",
      `${sqs}\nexport const make = () => createQueue({});`,
      "1:10",
      "createQueue",
    ],
    [
      "a namespace member",
      `import * as aws from "@notation/aws/sqs";\nexport const make = () => aws.createQueue({});`,
      "2:27",
      "aws.createQueue",
    ],
    [
      "a re-export",
      `export { createQueue } from "@notation/aws/sqs";`,
      "1:10",
      "createQueue",
    ],
    ["export *", `export * from "@notation/aws/sqs";`, "1:1", "createQueue"],
  ])("fails for a resource function imported by %s", (_, source, at, name) => {
    expect(check({ "shared/schema.ts": source })).toThrow(
      `shared/schema.ts:${at}: ${name} from @notation/aws/sqs can't be used in shared/schema.ts, a shared module (files.shared: "shared/**", the default), because a shared module also runs in the function, and ${name}() only runs at deploy. Move the code that uses ${name} to an infra module.`,
    );
  });

  it("fails for an import of an infra module, and names the import", () => {
    expect(
      check({
        "shared/schema.ts": `\nimport { orders } from "../infra/orders";\nexport const url = () => orders.url;`,
        "infra/orders.ts": orders,
      }),
    ).toThrow(
      'infra/orders.ts, an infra module (files.infra: "infra/**", the default), can\'t be used in shared/schema.ts, a shared module (files.shared: "shared/**", the default), because a shared module also runs in the function, and an infra module only runs at deploy. The shared module imports it through shared/schema.ts:2:1 → infra/orders.ts. Move the code that needs infra/orders.ts out of the shared module.',
    );
  });

  it("fails for an import of a runtime module", () => {
    expect(
      check({
        "shared/schema.ts": `import { NAME } from "../runtime/fn";\nexport const name = NAME;`,
        "runtime/fn.ts": `export const NAME = "fn";`,
      }),
    ).toThrow(
      'runtime/fn.ts, a runtime module (files.runtime: "runtime/**", the default), can\'t be used in shared/schema.ts, a shared module (files.shared: "shared/**", the default), because a shared module runs as written both at deploy and in the function, and a runtime module doesn\'t run as written at deploy. The shared module imports it through shared/schema.ts:1:1 → runtime/fn.ts.',
    );
  });

  it("names each import of a chain through modules that have no kind or are shared", () => {
    expect(
      check({
        "shared/schema.ts": `import { a } from "./other";\nexport const x = a;`,
        "shared/other.ts": `export { a } from "../lib/a";`,
        "lib/a.ts": `\n\nimport { b } from "./b";\nexport const a = b;`,
        "lib/b.ts": `export * from "../infra/orders";`,
        "infra/orders.ts": orders,
      }),
    ).toThrow(
      "imports it through shared/schema.ts:1:1 → shared/other.ts:1:1 → lib/a.ts:3:1 → lib/b.ts:1:1 → infra/orders.ts. Move the code that needs infra/orders.ts out of the shared module, or stop importing it through shared/other.ts.",
    );
  });

  it("fails for a side-effect import of an infra module", () => {
    expect(
      check({
        "shared/schema.ts": `import "../infra/orders";`,
        "infra/orders.ts": orders,
      }),
    ).toThrow("through shared/schema.ts:1:1 → infra/orders.ts.");
  });

  it("throws each time it checks a module that fails", () => {
    const analyses = new ModuleAnalyses({
      marks: virtualMarks(
        {
          ...packageFiles,
          "shared/schema.ts": `import "../infra/orders";`,
          "infra/orders.ts": orders,
        },
        packages,
      ),
      root,
    });
    const schema = abs("shared/schema.ts");
    expect(() => analyses.checkShared(schema)).toThrow("infra/orders.ts");
    expect(() => analyses.checkShared(schema)).toThrow("infra/orders.ts");
  });

  it.each([
    ["a JSX tag", `export const view = () => <Comp />;`],
    [
      "the object of a JSX member tag",
      `export const view = () => <Comp.Item />;`,
    ],
  ])("follows an import that the module uses only in %s", (_, body) => {
    expect(
      check(
        {
          "shared/view.tsx": `import { Comp } from "../runtime/Comp";\n${body}`,
          "runtime/Comp.tsx": `export const Comp = () => null;`,
        },
        "shared/view.tsx",
      ),
    ).toThrow("through shared/view.tsx:1:1 → runtime/Comp.tsx.");
  });

  it("doesn't count a JSX element whose tag starts with a lowercase letter", () => {
    check(
      {
        "shared/view.tsx": `import { div } from "../runtime/div";\nexport const view = () => <div />;`,
        "runtime/div.ts": `export const div = 1;`,
      },
      "shared/view.tsx",
    )();
  });

  it("follows the globs of the config", () => {
    const files = {
      "lib/schema.ts": `import { orders } from "../aws/orders";\nexport const url = () => orders.url;`,
      "aws/orders.ts": orders,
    };
    const globs = { shared: ["lib/**"], infra: ["aws/**"] };
    expect(check(files, "lib/schema.ts", globs)).toThrow(
      'aws/orders.ts, an infra module (files.infra: "aws/**"), can\'t be used in lib/schema.ts, a shared module (files.shared: "lib/**"),',
    );
    expect(check(files, "lib/schema.ts", { infra: ["aws/**"] })).not.toThrow();
  });

  it.each([
    ["import type", `import type { Order } from "../infra/orders";`],
    ["a type specifier", `import { type Order } from "../infra/orders";`],
    [
      "an import used only in types",
      `import { Order } from "../infra/orders";`,
    ],
    ["export type", `export type { Order } from "../infra/orders";`],
  ])("passes for %s of an infra module", (_, source) => {
    check({
      "shared/schema.ts": `${source}\nexport type Orders = Order[];`,
      "infra/orders.ts": orders,
    })();
  });

  it("checks only modules that files.shared matches", () => {
    check(
      {
        "lib/schema.ts": `import { orders } from "../infra/orders";\nexport const url = () => orders.url;`,
        "infra/orders.ts": orders,
      },
      "lib/schema.ts",
    )();
  });
});
