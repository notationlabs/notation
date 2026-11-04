import { afterAll, beforeAll, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { matchesRuntimeModules } from "src/runtime-modules";

beforeAll(() => setConfigFile("/project/notation.config.ts"));
afterAll(() => setConfigFile(undefined));

it.each([
  ["/project/runtime/todos.fn.ts", ["**/*.fn.ts"], true],
  ["/project/todos.fn.ts", ["**/*.fn.ts"], true],
  ["/project/runtime/todos.ts", ["**/*.fn.ts"], false],
  ["/project/runtime/todos.ts", ["**/runtime/**"], true],
  ["/project/src/runtime/jobs/sync.ts", ["**/runtime/**"], true],
  ["/project/jobs/sync.ts", ["**/runtime/**", "jobs/*.ts"], true],
  ["/project/node_modules/pkg/todos.fn.ts", ["**/*.fn.ts"], false],
  ["/project/dist/runtime/todos/index.mjs", ["**/runtime/**"], false],
  ["/other/todos.fn.ts", ["**/*.fn.ts"], false],
])("%s matching %j: %s", (filePath, globs, expected) => {
  expect(matchesRuntimeModules(filePath, globs)).toBe(expected);
});
