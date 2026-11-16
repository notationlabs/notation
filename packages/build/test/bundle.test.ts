import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import { ResourceNotFoundError } from "@notation/resource";
import {
  bundleInputFiles,
  clearBuildCache,
  readInputs,
} from "src/bundle/cache";
import { bundle, type Bundle, type BundleSchema } from "src/resources/bundle";

const { builds } = vi.hoisted(() => ({
  builds: { count: 0, during: undefined as (() => void) | undefined },
}));

vi.mock("rolldown", async (importOriginal) => {
  const original = await importOriginal<typeof import("rolldown")>();
  return {
    ...original,
    rolldown: async (...args: Parameters<typeof original.rolldown>) => {
      builds.count++;
      const build = await original.rolldown(...args);
      builds.during?.();
      return build;
    },
  };
});

// Inside the repository, as in the CLI's tests.
const tmpDir = fileURLToPath(new URL("../../../tmp", import.meta.url));

let root: string;
let roots: string[] = [];

function makeRoot(): string {
  mkdirSync(tmpDir, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(tmpDir, "notation-bundle-")));
  roots.push(dir);
  return dir;
}

function useRoot(dir: string) {
  root = dir;
  setConfigFile(path.join(dir, "notation.config.ts"));
}

// Sets the file's mtime a minute back, as a build that starts in the same
// millisecond as the write would count the file as modified during it.
const write = (file: string, contents: string, dir = root) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), contents);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path.join(dir, file), past, past);
};

const read = (file: string) => readFileSync(path.join(root, file), "utf8");

beforeEach(() => {
  useRoot(makeRoot());
  write(
    "notation.config.ts",
    `export default { app: "app", entry: "infra/main.ts" }`,
  );
  write("package.json", JSON.stringify({ name: "app", type: "module" }));
  clearBuildCache();
  builds.count = 0;
  builds.during = undefined;
});

afterEach(() => {
  setConfigFile(undefined);
  vi.unstubAllEnvs();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

// Plans the bundle, then deploys it, as the reconciler does: params, then
// create, then read.
async function deploy(resource: Bundle) {
  const params = { ...resource.config, ...(await resource.deriveParams()) };
  await resource.create(params);
  return { params, output: await resource.read!(params) };
}

const worker = (entry = "src/worker.ts", modules?: Record<string, string>) =>
  bundle({ id: "router", platform: "workerd", entry, modules });

describe("bundle()", () => {
  it("reads the value exports of its entry", () => {
    write(
      "src/worker.ts",
      [
        `import type { Thing } from "./thing";`,
        `export interface Shape {}`,
        `export type Alias = Thing;`,
        `export class Room {}`,
        `export { Lobby } from "./lobby";`,
        `export * from "./more";`,
        `export default { fetch() { return new Response("ok"); } };`,
      ].join("\n"),
    );
    expect(worker().exports).toEqual({
      names: ["Lobby", "Room", "default"],
      stars: ["./more"],
    });
  });

  it("reads the exports of an entry in modules", () => {
    const resource = worker("virtual:main", {
      "virtual:main": `export class Room {}\nexport default {};`,
    });
    expect(resource.config.Entry).toBe("virtual:main");
    expect(resource.exports.names).toEqual(["Room", "default"]);
  });

  it("keys the bundle by its id, with the entry relative to the project root", () => {
    write("src/worker.ts", "export default {};");
    const resource = bundle({
      id: "router",
      platform: "workerd",
      entry: path.join(root, "src/worker.ts"),
    });
    expect(resource.id).toBe("bundle:router");
    expect(resource.config).toEqual({
      Id: "router",
      Entry: "src/worker.ts",
      Platform: "workerd",
    });
  });

  it("keeps the symlinks in the path of its entry, and builds from the real path", async () => {
    write(
      "packages/greet@1.0.0/index.js",
      `export default { fetch() { return "linked"; } };`,
    );
    mkdirSync(path.join(root, "node_modules"));
    symlinkSync(
      path.join(root, "packages/greet@1.0.0"),
      path.join(root, "node_modules/greet"),
    );
    const resource = worker("node_modules/greet/index.js");
    expect(resource.config.Entry).toBe("node_modules/greet/index.js");
    await deploy(resource);
    expect(read("dist/.bundles/router/index.mjs")).toContain(`"linked"`);
  });

  it("makes an entry under the real path of a symlinked root relative to the real path", () => {
    const real = root;
    const link = path.join(makeRoot(), "link");
    symlinkSync(real, link);
    useRoot(link);
    write("src/worker.ts", "export default {};");
    const resource = worker(path.join(real, "src/worker.ts"));
    expect(resource.config.Entry).toBe("src/worker.ts");
  });

  it("fails for a module whose source is not a string", () => {
    expect(() =>
      worker("src/worker.ts", { "virtual:n": 1 as unknown as string }),
    ).toThrow(
      'bundle({ id: "router" }) has the module "virtual:n" in modules, whose source is not a string.',
    );
  });

  it("fails for a workerd entry that exports a primitive", () => {
    write("src/worker.ts", `export const NAME = "x";\nexport default {};`);
    expect(() => worker()).toThrow(
      "src/worker.ts:1:14: the module exports NAME, whose value is a primitive",
    );
  });

  it("fails for an id that is not name-safe", () => {
    expect(() =>
      bundle({ id: "a b", platform: "node", entry: "x.ts" }),
    ).toThrow('Invalid bundle() id "a b"');
  });

  it("fails for a module whose specifier starts with . or /", () => {
    for (const specifier of ["./routes", "/routes"]) {
      expect(() =>
        bundle({
          id: "router",
          platform: "workerd",
          entry: "src/worker.ts",
          modules: { [specifier]: "export default [];" },
        }),
      ).toThrow(
        `bundle({ id: "router" }) has the module "${specifier}" in modules. A key of modules can't start with "." or "/"`,
      );
    }
  });

  it("fails for an entry that it can't read", () => {
    expect(() => worker("src/missing.ts")).toThrow(
      'bundle({ id: "router" }) can\'t read its entry src/missing.ts',
    );
  });
});

describe("Bundle", () => {
  it("writes the module for workerd, with the outputs of a std.fs.File", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const { params, output } = await deploy(worker());

    expect(params.FilePath).toBe("dist/.bundles/router/index.mjs");
    expect(output.filePath).toBe("dist/.bundles/router/index.mjs");
    expect(read("dist/.bundles/router/index.mjs")).toContain("fetch()");
    expect(output.fileSha256).toBe(readInputs("router")!.fileSha256);
  });

  it("writes index.mjs and a zip that holds it for node", async () => {
    write("src/handler.ts", `export const handler = async () => "ok";`);
    const resource = bundle({
      id: "api",
      platform: "node",
      entry: "src/handler.ts",
    });
    const { params } = await deploy(resource);

    expect(params.FilePath).toBe("dist/.bundles/api/index.zip");
    const zip = unzipSync(readFileSync(path.join(root, params.FilePath)));
    expect(Object.keys(zip)).toEqual(["index.mjs"]);
    expect(new TextDecoder().decode(zip["index.mjs"])).toBe(
      read("dist/.bundles/api/index.mjs"),
    );
  });

  it("builds generated modules, in TypeScript when the specifier ends in .ts", async () => {
    const resource = worker("virtual:main.ts", {
      "virtual:main.ts": `import routes from "virtual:routes";\nconst list: string = routes.join(",");\nexport default { fetch() { return list; } };`,
      "virtual:routes": `export default ["/a", "/b"];`,
    });
    await deploy(resource);
    const code = read("dist/.bundles/router/index.mjs");
    expect(code).toContain(`"/a"`);
    expect(code).not.toContain(": number");
  });

  it("reads and builds JSX in an entry and in a module whose specifier ends in .jsx", async () => {
    write(
      "src/worker.jsx",
      [
        `import view from "virtual:view.jsx";`,
        `const h = (tag) => tag;`,
        `export class Room {}`,
        `export default { fetch() { return view + <main />; } };`,
      ].join("\n"),
    );
    const resource = bundle({
      id: "router",
      platform: "workerd",
      entry: "src/worker.jsx",
      modules: {
        "virtual:view.jsx": `const h = (tag) => tag;\nexport default <p />;`,
      },
    });
    expect(resource.exports.names).toEqual(["Room", "default"]);
    await deploy(resource);
    expect(read("dist/.bundles/router/index.mjs")).not.toContain("<p />");
  });

  it("resolves a modules key that names a Node built-in to its module, on both platforms", async () => {
    for (const platform of ["workerd", "node"] as const) {
      const resource = bundle({
        id: platform,
        platform,
        entry: "virtual:main",
        modules: {
          "virtual:main": `import name from "events";\nexport default { fetch() { return name; } };`,
          events: `export default "from modules";`,
        },
      });
      await deploy(resource);
      expect(read(`dist/.bundles/${platform}/index.mjs`)).toContain(
        `"from modules"`,
      );
    }
  });

  it("has the same hash when it is built twice", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const first = (await worker().deriveParams()).FileSha256;
    clearBuildCache();
    rmSync(path.join(root, "dist"), { recursive: true });
    const second = (await worker().deriveParams()).FileSha256;
    expect(builds.count).toBe(2);
    expect(second).toBe(first);
  });

  it("has the same hash when it is built from two directories", async () => {
    const files: Record<string, string> = {
      "notation.config.ts": `export default { app: "app", entry: "infra/main.ts" }`,
      "package.json": JSON.stringify({ name: "app", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "~/*": ["./src/*"] } },
      }),
      "node_modules/greet/package.json": JSON.stringify({
        name: "greet",
        type: "module",
        exports: "./index.js",
      }),
      "node_modules/greet/index.js": `export const greet = (name) => "hi " + name + " " + import.meta.url;`,
      "src/name.ts": `export const name = "world";`,
      "src/handler.ts": [
        `import { greet } from "greet";`,
        `import { name } from "~/name";`,
        `export const handler = async () => greet(name) + __dirname + import.meta.url;`,
      ].join("\n"),
    };
    const hashes: string[] = [];
    for (const dir of [root, makeRoot()]) {
      useRoot(dir);
      for (const [file, contents] of Object.entries(files)) {
        write(file, contents, dir);
      }
      const resource = bundle({
        id: "api",
        platform: "node",
        entry: "src/handler.ts",
      });
      await deploy(resource);
      hashes.push(readInputs("api")!.fileSha256);
      expect(read("dist/.bundles/api/index.mjs")).toContain("hi ");
    }
    expect(hashes[1]).toBe(hashes[0]);
  });

  it("doesn't build again for a second plan with no changes", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    await deploy(worker());
    expect(builds.count).toBe(1);

    clearBuildCache();
    const params = await worker().deriveParams();
    expect(builds.count).toBe(1);
    expect(params.FileSha256).toBe(readInputs("router")!.fileSha256);
  });

  it("doesn't write the inputs file when an input is modified during the build", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    builds.during = () => {
      const file = path.join(root, "src/worker.ts");
      writeFileSync(file, `export default { fetch() { return 2; } };`);
      // The second the filesystem records can start before the build did.
      const recorded = new Date(Math.floor(Date.now() / 1000) * 1000);
      utimesSync(file, recorded, recorded);
    };
    await deploy(worker());
    expect(readInputs("router")).toBeUndefined();

    builds.during = undefined;
    const settled = new Date(Date.now() - 60_000);
    utimesSync(path.join(root, "src/worker.ts"), settled, settled);
    clearBuildCache();
    await worker().deriveParams();
    expect(builds.count).toBe(2);
    expect(readInputs("router")).toBeDefined();
  });

  it("writes the inputs file when an input's mtime is ahead of the clock", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(path.join(root, "src/worker.ts"), future, future);
    await deploy(worker());
    expect(readInputs("router")).toBeDefined();
  });

  it("builds a new bundle once in a deploy, not once per deriveParams call", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const resource = worker();
    await resource.deriveParams();
    await resource.deriveParams();
    await deploy(resource);
    expect(builds.count).toBe(1);
  });

  it("builds once for concurrent deriveParams calls", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const resource = worker();
    const [first, second] = await Promise.all([
      resource.deriveParams(),
      resource.deriveParams(),
    ]);
    expect(builds.count).toBe(1);
    expect(second).toEqual(first);
  });

  it("builds again after a build that failed", async () => {
    write(
      "src/worker.ts",
      `import n from "./n";\nexport default { fetch() { return n; } };`,
    );
    const resource = worker();
    await expect(resource.deriveParams()).rejects.toThrow();
    write("src/n.ts", `export default 1;`);
    await resource.deriveParams();
    expect(builds.count).toBe(2);
  });

  it("reads the hash of the file on disk under FileSha256, and an update rewrites the file", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const resource = worker();
    const { params } = await deploy(resource);
    write("dist/.bundles/router/index.mjs", "export default {};");

    // The type of read holds only the outputs.
    const readParams = async () =>
      (await resource.read!(params)) as BundleSchema["ReadResult"];
    const output = await readParams();
    expect(output.FilePath).toBe(params.FilePath);
    expect(output.FileSha256).not.toBe(params.FileSha256);

    await resource.update(params, params, params);
    expect((await readParams()).FileSha256).toBe(params.FileSha256);
  });

  it("writes the inputs file when it creates the bundle after a delete", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const resource = worker();
    const { params, output } = await deploy(resource);
    await resource.delete(params, {
      ...params,
      filePath: output.filePath!,
      fileSha256: output.fileSha256!,
    });
    await resource.create(params);
    expect(builds.count).toBe(1);
    expect(readInputs("router")?.fileSha256).toBe(params.FileSha256);
  });

  it("builds again when the output is missing", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    await deploy(worker());
    rmSync(path.join(root, "dist/.bundles/router/index.mjs"));
    clearBuildCache();

    await deploy(worker());
    expect(builds.count).toBe(2);
    expect(existsSync(path.join(root, "dist/.bundles/router/index.mjs"))).toBe(
      true,
    );
  });

  describe("builds again after a change to", () => {
    beforeEach(() => {
      write("tsconfig.base.json", `{ /* base */ "compilerOptions": {}, }`);
      write(
        "tsconfig.json",
        `{\n  // the base\n  "compilerOptions": { "paths": { "~/*": ["./src/*",] } },\n  "extends": ["./tsconfig.base.json",],\n}`,
      );
      write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
      write(
        "node_modules/greet/package.json",
        JSON.stringify({
          name: "greet",
          type: "module",
          exports: "./index.js",
        }),
      );
      write("node_modules/greet/index.js", `export const greet = () => "hi";`);
      write("src/util.ts", `export const n = 1;`);
      write(
        "src/worker.ts",
        `import { greet } from "greet";\nimport { n } from "./util";\nexport default { fetch() { return greet() + n + process.env.NODE_ENV; } };`,
      );
    });

    const rebuilds = async (change: () => void, modules?: () => Bundle) => {
      const make = modules ?? (() => worker());
      await deploy(make());
      expect(builds.count).toBe(1);
      change();
      clearBuildCache();
      await make().deriveParams();
      expect(builds.count).toBe(2);
    };

    it("an imported file", () =>
      rebuilds(() => write("src/util.ts", `export const n = 2;`)));

    it("a package.json", () =>
      rebuilds(() =>
        write(
          "node_modules/greet/package.json",
          JSON.stringify({
            name: "greet",
            version: "2.0.0",
            type: "module",
            exports: "./index.js",
          }),
        ),
      ));

    it("a tsconfig that another extends", () =>
      rebuilds(() =>
        write(
          "tsconfig.base.json",
          `{ "compilerOptions": { "strict": true } }`,
        ),
      ));

    it("a tsconfig that another references", () => {
      write(
        "tsconfig.json",
        `{ "files": [], "references": [{ "path": "./tsconfig.app.json" },] }`,
      );
      write("tsconfig.app.json", `{ "compilerOptions": {} }`);
      return rebuilds(() =>
        write("tsconfig.app.json", `{ "compilerOptions": { "strict": true } }`),
      );
    });

    it("the tsconfig.json of a directory that a tsconfig references", () => {
      write(
        "tsconfig.json",
        `{ "files": [], "references": [{ "path": "./tools" }] }`,
      );
      write("tools/tsconfig.json", `{ "compilerOptions": {} }`);
      return rebuilds(() =>
        write(
          "tools/tsconfig.json",
          `{ "compilerOptions": { "strict": true } }`,
        ),
      );
    });

    it("the lockfile", () =>
      rebuilds(() => write("pnpm-lock.yaml", "lockfileVersion: '9.1'\n")));

    it("NODE_ENV", () => rebuilds(() => vi.stubEnv("NODE_ENV", "development")));

    it("a modules source", async () => {
      let source = "export default 1;";
      await rebuilds(
        () => (source = "export default 2;"),
        () =>
          worker("virtual:main", {
            "virtual:main": `import n from "virtual:n";\nexport default { fetch() { return n; } };`,
            "virtual:n": source,
          }),
      );
    });

    it("records the files that the build read", async () => {
      await deploy(worker());
      expect(Object.keys(readInputs("router")!.files)).toEqual([
        "node_modules/greet/index.js",
        "node_modules/greet/package.json",
        "package.json",
        "pnpm-lock.yaml",
        "src/util.ts",
        "src/worker.ts",
        "tsconfig.base.json",
        "tsconfig.json",
      ]);
      expect(bundleInputFiles(root)).toContain(path.join(root, "src/util.ts"));
    });
  });

  it("puts a dynamic import in the one output file", async () => {
    write("src/lazy.ts", `export const lazy = "lazy value";`);
    write(
      "src/worker.ts",
      `export default { async fetch() { return (await import("./lazy")).lazy; } };`,
    );
    await deploy(worker());
    expect(read("dist/.bundles/router/index.mjs")).toContain("lazy value");
    expect(
      readdir("dist/.bundles/router").filter((f) => f.endsWith(".mjs")),
    ).toEqual(["index.mjs"]);
  });

  it("passes the check of the output's exports for an entry with export *", async () => {
    write("src/rooms.ts", `export class Room {}\nexport class Lobby {}`);
    write(
      "src/worker.ts",
      `export * from "./rooms";\nexport class Hall {}\nexport default {};`,
    );
    await expect(deploy(worker())).resolves.toBeDefined();
    expect(read("dist/.bundles/router/index.mjs")).toMatch(/Lobby/);
  });

  it("fails when the output renders an infra module of the project", async () => {
    write("infra/region.ts", `export const region = { name: "eu" };`);
    write(
      "src/worker.ts",
      `import { region } from "../infra/region";\nexport default { fetch() { return region.name; } };`,
    );
    await expect(worker().deriveParams()).rejects.toThrow(
      'infra/region.ts, an infra module (files.infra: "infra/**", the default), can\'t be used in bundle:router, because an infra module only runs at deploy. The code uses region at src/worker.ts:2:35, and imports infra/region.ts through src/worker.ts → infra/region.ts.',
    );
  });

  it("fails when the output renders a @resource export of a package", async () => {
    write(
      "node_modules/infra-lib/package.json",
      JSON.stringify({
        name: "infra-lib",
        type: "module",
        exports: "./index.js",
      }),
    );
    write(
      "node_modules/infra-lib/index.js",
      `/**\n * @resource\n */\nexport function queue(id) { return { id }; }\n`,
    );
    write(
      "src/worker.ts",
      `import { queue } from "infra-lib";\nexport default { fetch() { return queue("q"); } };`,
    );
    await expect(worker().deriveParams()).rejects.toThrow(
      "queue from infra-lib/index.js can't be used in bundle:router, because queue() declares infrastructure",
    );
  });

  it("fails when the output calls a @resource tag of a package", async () => {
    write(
      "node_modules/refs-lib/package.json",
      JSON.stringify({
        name: "refs-lib",
        type: "module",
        exports: "./index.js",
      }),
    );
    write(
      "node_modules/refs-lib/index.js",
      `/**\n * @resource\n */\nexport function text(strings, ...parts) { return { strings, parts }; }\n`,
    );
    write(
      "src/worker.ts",
      `import { text } from "refs-lib";\nexport default { fetch(request) { return text\`\${request.url}/x\`; } };`,
    );
    await expect(worker().deriveParams()).rejects.toThrow(
      "text from refs-lib/index.js can't be used in bundle:router, because text() declares infrastructure",
    );
  });

  it("fails when the output renders a @declaration export of a package", async () => {
    write(
      "node_modules/fn-lib/package.json",
      JSON.stringify({ name: "fn-lib", type: "module", exports: "./index.js" }),
    );
    write(
      "node_modules/fn-lib/index.js",
      `/**\n * @declaration shared: id; entry: handler\n */\nexport function $fn(config) { return { id: config.id }; }\n`,
    );
    write(
      "src/worker.ts",
      `import { $fn } from "fn-lib";\nconst fn = $fn({ id: "x" });\nexport default { fetch() { return fn.id; } };`,
    );
    await expect(worker().deriveParams()).rejects.toThrow(
      "$fn from fn-lib/index.js can't be used in bundle:router, because $fn() declares infrastructure",
    );
  });

  it("fails at deploy when the build differs from the plan", async () => {
    write("src/worker.ts", `export default { fetch() { return 1; } };`);
    const resource = worker();
    const params = { ...resource.config, ...(await resource.deriveParams()) };
    write("src/worker.ts", `export default { fetch() { return 2; } };`);
    await expect(resource.create(params)).rejects.toThrow(
      `bundle:router built to SHA-256 `,
    );
    await expect(resource.create(params)).rejects.toThrow(
      `but the plan expects ${params.FileSha256}. An input of the bundle changed after the plan, or its build is not deterministic. Start a new deploy.`,
    );
  });

  it("reads a missing output as not found", async () => {
    write("src/worker.ts", `export default {};`);
    const resource = worker();
    const params = { ...resource.config, ...(await resource.deriveParams()) };
    await expect(resource.read!(params)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("deletes its directory", async () => {
    write("src/worker.ts", `export default {};`);
    const resource = worker();
    const { params, output } = await deploy(resource);
    await resource.delete(params, {
      ...params,
      filePath: output.filePath!,
      fileSha256: output.fileSha256!,
    });
    expect(existsSync(path.join(root, "dist/.bundles/router"))).toBe(false);
  });
});

const readdir = (dir: string) => readdirSync(path.join(root, dir));
