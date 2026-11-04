import { afterEach, expect, it } from "vitest";
import {
  addOutputSource,
  clearOutputValues,
  findOutputValue,
  hasOutputValuesBelow,
  outputKey,
  parseOutputKey,
  read,
  setOutputValues,
} from "src/outputs";

afterEach(() => clearOutputValues());

it("makes and parses output keys", () => {
  expect(outputKey("infra/orders", "orderQueue", ["url"])).toBe(
    "infra/orders#orderQueue.url",
  );
  expect(outputKey("infra/orders", "orderQueue")).toBe(
    "infra/orders#orderQueue",
  );
  expect(parseOutputKey("infra/orders#orderQueue.url")).toEqual({
    module: "infra/orders",
    binding: "orderQueue",
    path: ["url"],
  });
  expect(() => parseOutputKey("orderQueue.url")).toThrow(
    "is not an output key",
  );
});

it("reads a value by its key, or from the value of a shorter key", () => {
  setOutputValues({
    "infra/orders#orderQueue.url": "https://sqs.test/orders",
    "infra/orders#settings": { memory: 64 },
  });
  expect(read("infra/orders#orderQueue", ["url"])).toBe(
    "https://sqs.test/orders",
  );
  expect(read("infra/orders#orderQueue", ["url", "length"])).toBe(23);
  expect(read("infra/orders#settings", ["memory"])).toBe(64);
  expect(() => read("infra/orders#orderQueue", ["arn"])).toThrow(
    "No value for infra/orders#orderQueue.arn",
  );
});

it("loads each source at the first read, without replacing values that are set", () => {
  setOutputValues({ "infra/orders#a": "set" });
  addOutputSource(() => ({ "infra/orders#a": "source", "infra/orders#b": 2 }));
  expect(read("infra/orders#a", [])).toBe("set");
  expect(read("infra/orders#b", [])).toBe(2);
});

it("finds a value without throwing, and tells whether keys below one are set", () => {
  setOutputValues({ "infra/api#api.stage.url": undefined });
  expect(findOutputValue("infra/api#api", ["stage", "url"])).toEqual({
    value: undefined,
  });
  expect(findOutputValue("infra/api#api", ["stage"])).toBeUndefined();
  expect(hasOutputValuesBelow("infra/api#api.stage")).toBe(true);
  expect(hasOutputValuesBelow("infra/api#api.stage.url")).toBe(false);
});
