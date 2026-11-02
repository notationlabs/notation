import { describe, expect, it } from "vitest";
import { defineConfig, parseConfig } from "src/config/config";

describe("defineConfig", () => {
  it("returns the config", () => {
    const config = {
      app: "orders-app",
      entry: "infra/api.ts",
      defaultStage: "dev",
    } as const;
    expect(defineConfig(config)).toBe(config);
  });

  it("checks names at compile time", () => {
    defineConfig({
      // @ts-expect-error
      app: "Orders_App",
      entry: "infra/api.ts",
    });
    defineConfig({
      app: "orders-app",
      entry: "infra/api.ts",
      // @ts-expect-error
      defaultStage: "dev-",
    });
    defineConfig({
      // @ts-expect-error
      app: "orders--app",
      entry: "infra/api.ts",
    });
    defineConfig({
      // @ts-expect-error
      app: "a".repeat(33) as "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      entry: "infra/api.ts",
    });
    defineConfig({
      app: "a".repeat(32) as "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      entry: "infra/api.ts",
    });
  });

  it("rejects widened strings at compile time", () => {
    const app: string = "orders-app";
    defineConfig({
      // @ts-expect-error
      app,
      entry: "infra/api.ts",
    });
  });
});

describe("parseConfig", () => {
  const valid = {
    app: "orders-app",
    entry: "infra/api.ts",
  };

  it("accepts a valid config", () => {
    const config = {
      ...valid,
      defaultStage: "dev",
    };
    expect(parseConfig(config)).toBe(config);
  });

  it.each([
    [undefined, "the default export must be an object"],
    [{ ...valid, app: undefined }, "app undefined is not name-safe"],
    [{ ...valid, app: "Orders_App" }, 'app "Orders_App" is not name-safe'],
    [{ app: "orders-app" }, "entry must be a path to an entry file"],
    [{ ...valid, entry: "" }, "entry must be a path to an entry file"],
    [{ ...valid, entry: 1 }, "entry must be a path to an entry file"],
    [{ ...valid, defaultStage: "Dev" }, 'defaultStage "Dev" is not name-safe'],
    [
      { ...valid, stage: "dev" },
      'unknown key "stage". Known keys: app, entry, defaultStage',
    ],
    [{ ...valid, name: "x", entries: {} }, 'unknown keys "name", "entries"'],
  ])("rejects %j", (config, message) => {
    expect(() => parseConfig(config)).toThrow(
      `Invalid notation.config.ts: ${message}`,
    );
  });

  it("names the given config file in errors", () => {
    expect(() => parseConfig({ app: "orders-app" }, "jobs.config.ts")).toThrow(
      "Invalid jobs.config.ts: entry must be a path to an entry file",
    );
  });
});
