import { describe, expect, it } from "vitest";
import { defineConfig, parseConfig } from "src/config/config";

describe("defineConfig", () => {
  it("returns the config", () => {
    const config = {
      app: "orders-app",
      entries: { orders: "infra/api.ts" },
      defaultStage: "dev",
    } as const;
    expect(defineConfig(config)).toBe(config);
  });

  it("checks names at compile time", () => {
    defineConfig({
      // @ts-expect-error
      app: "Orders_App",
      entries: { orders: "infra/api.ts" },
    });
    defineConfig({
      app: "orders-app",
      // @ts-expect-error
      entries: { Orders: "infra/api.ts" },
    });
    defineConfig({
      app: "orders-app",
      entries: { orders: "infra/api.ts" },
      // @ts-expect-error
      defaultStage: "dev-",
    });
    defineConfig({
      // @ts-expect-error
      app: "a".repeat(33) as "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      entries: { orders: "infra/api.ts" },
    });
    defineConfig({
      app: "a".repeat(32) as "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      entries: { orders: "infra/api.ts", "orders-worker": "infra/worker.ts" },
    });
  });

  it("rejects widened strings at compile time", () => {
    const app: string = "orders-app";
    const entries: Record<string, string> = { orders: "infra/api.ts" };
    defineConfig({
      // @ts-expect-error
      app,
      entries: { orders: "infra/api.ts" },
    });
    defineConfig({
      app: "orders-app",
      // @ts-expect-error
      entries,
    });
  });
});

describe("parseConfig", () => {
  const valid = {
    app: "orders-app",
    entries: { orders: "infra/api.ts" },
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
    [{ app: "orders-app" }, "entries must be an object"],
    [{ ...valid, entries: {} }, "entries must name at least one entry"],
    [
      { ...valid, entries: { Orders: "infra/api.ts" } },
      'entry name "Orders" is not name-safe',
    ],
    [
      { ...valid, entries: { orders: 1 } },
      'entry "orders" must be a path to an entry file',
    ],
    [{ ...valid, defaultStage: "Dev" }, 'defaultStage "Dev" is not name-safe'],
    [
      { ...valid, stage: "dev" },
      'unknown key "stage". Known keys: app, entries, defaultStage',
    ],
    [{ ...valid, name: "x", entry: "y" }, 'unknown keys "name", "entry"'],
  ])("rejects %j", (config, message) => {
    expect(() => parseConfig(config)).toThrow(message);
  });
});
