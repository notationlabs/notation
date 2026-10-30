import { beforeAll, expect, it } from "vitest";
import { $ } from "execa";
import path from "path";
import { glob } from "glob";

const cwd = path.join(process.cwd(), "examples/api-gateway");
const $$ = $({ cwd });

beforeAll(async () => {
  await $$`rm -rf dist`;
  await $$`npm run compile`;
});

it("generates infra and runtime modules matching source file structure", async () => {
  const expected = ["dist/infra/api.mjs", "dist/runtime/todos.fn/index.mjs"];
  const actual = await glob("dist/**/*.{js,mjs,zip}", { cwd });
  expect(actual.sort()).toEqual(expected);
});
