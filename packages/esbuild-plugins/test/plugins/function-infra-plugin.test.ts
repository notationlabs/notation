import { expect, it } from "vitest";
import { functionInfraPlugin } from "src/plugins/function-infra-plugin";
import { createBuilder } from "test/esbuild-test-utils";

const buildInfra = createBuilder((input) => ({
  entryPoints: ["entry.fn.ts"],
  format: "esm",
  plugins: [functionInfraPlugin({ getFile: () => input })],
}));

it("gives each handler the id <module id>-<handler>", async () => {
  const input = `
    import { handle } from "@notation/aws/lambda.fn";
    export const getNum = handle.apiRequest(() => 1);
    export const getDoubleNum = handle.apiRequest(() => 2);
    export const config = { service: "aws/lambda", id: "nums", memory: 64 };
  `;

  const output = await buildInfra(input);

  expect(output).toContain('import { lambda } from "@notation/aws/lambda"');
  expect(output).toContain(
    'const getNum = lambda({ code: { type: "file", path: "dist/entry.fn/index.mjs" }, handler: "getNum", ...config, id: "nums-getNum" });',
  );
  expect(output).toContain(
    'handler: "getDoubleNum", ...config, id: "nums-getDoubleNum"',
  );
});

it("fails if the config has no id", async () => {
  const input = `
    import { handle } from "@notation/aws/lambda.fn";
    export const getNum = handle.apiRequest(() => 1);
    export const config = { service: "aws/lambda" };
  `;

  await expect(buildInfra(input)).rejects.toThrow(
    /the config export must set an id/,
  );
});

it("fails if the config id is not name-safe", async () => {
  const input = `
    import { handle } from "@notation/aws/lambda.fn";
    export const getNum = handle.apiRequest(() => 1);
    export const config = { service: "aws/lambda", id: "my.module" };
  `;

  await expect(buildInfra(input)).rejects.toThrow(
    /invalid config id "my\.module"/,
  );
});

it("allows <id>-<handler> up to 59 characters", async () => {
  const input = `
    import { handle } from "@notation/aws/lambda.fn";
    export const getNum = handle.apiRequest(() => 1);
    export const config = { service: "aws/lambda", id: "${"a".repeat(52)}" };
  `;

  const output = await buildInfra(input);

  expect(output).toContain(`id: "${"a".repeat(52)}-getNum"`);
});

it("fails if <id>-<handler> is longer than 59 characters", async () => {
  const input = `
    import { handle } from "@notation/aws/lambda.fn";
    export const getNum = handle.apiRequest(() => 1);
    export const config = { service: "aws/lambda", id: "${"a".repeat(53)}" };
  `;

  await expect(buildInfra(input)).rejects.toThrow(
    /the function id "a{53}-getNum" \(`<id>-<handler>`\) must be at most 59/,
  );
});

it("fails if no config is exported", async () => {
  const input = `
    import { handle } from "@notation/aws/lambda.fn";
    export const getNum = handle.apiRequest(() => 1);
  `;

  await expect(buildInfra(input)).rejects.toThrow(
    /A config object was not exported/,
  );
});
