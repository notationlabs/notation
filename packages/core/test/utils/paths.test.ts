import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "src/utils/paths";

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "notation-root-")));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function touch(...segments: string[]) {
  const file = path.join(tmp, ...segments);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
}

describe("findProjectRoot", () => {
  it("finds the config in a parent directory", async () => {
    await touch("package.json");
    await touch("notation.config.ts");
    await mkdir(path.join(tmp, "infra/nested"), { recursive: true });

    expect(findProjectRoot(path.join(tmp, "infra/nested"))).toBe(tmp);
  });

  it("prefers notation.config.ts to a nearer directory without a package.json", async () => {
    await touch("notation.config.ts");
    await touch("infra/README.md");

    expect(findProjectRoot(path.join(tmp, "infra"))).toBe(tmp);
  });

  it("prefers the config next to the nearest package.json to one above it", async () => {
    await touch("notation.config.ts");
    await touch("app/package.json");
    await touch("app/notation.config.ts");

    expect(findProjectRoot(path.join(tmp, "app"))).toBe(path.join(tmp, "app"));
  });

  it("stops at the nearest package.json when it has no config", async () => {
    await touch("package.json");
    await touch("notation.config.ts");
    await touch("packages/app/package.json");
    await mkdir(path.join(tmp, "packages/app/src"), { recursive: true });

    expect(findProjectRoot(path.join(tmp, "packages/app/src"))).toBe(
      path.join(tmp, "packages/app"),
    );
  });

  it("falls back to the directory without a config or package.json", async () => {
    const dir = path.join(tmp, "a/b");
    await mkdir(dir, { recursive: true });

    // The temp directory has no package.json above it, so the search reaches
    // the filesystem root.
    expect(findProjectRoot(dir)).toBe(dir);
  });
});
