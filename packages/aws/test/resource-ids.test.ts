import { expect, test } from "vitest";
import { collectResourceGraph, type ResourceGraph } from "@notation/resource";
import { api } from "src/api-gateway";
import { route } from "src/api-gateway/route";
import { eventBus, rate, rule, schedule } from "src/event-bridge";
import { eventSourceMapping, lambda } from "src/lambda";
import { queue } from "src/sqs";
import { Unknown } from "./declare";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

const duplicateIds = (graph: ResourceGraph) => {
  const ids = graph.resources.map((resource) => resource.id);
  return ids.filter((id, index) => ids.indexOf(id) !== index);
};

test("resources of declarations of different types with the same id have different ids", async () => {
  const graph = await collectResourceGraph(() => {
    const fn = lambda({ id: "todos", code });
    api({ id: "todos" });
    queue({ id: "todos", schema: Unknown });
    schedule({ id: "todos", schedule: rate(1, "day"), target: fn });
    rule({
      id: "todos",
      name: "todo-events",
      bus: eventBus({ id: "todos" }),
      pattern: { source: ["todos"] },
      target: fn,
    });
  });

  expect(duplicateIds(graph)).toEqual([]);
});

test("ids that join to the same text with a hyphen give different resource ids", async () => {
  const graph = await collectResourceGraph(() => {
    const bc = lambda({ id: "b-c", code });
    const c = lambda({ id: "c", code });
    const a = queue({ id: "a", schema: Unknown });
    const ab = queue({ id: "a-b", schema: Unknown });
    eventSourceMapping({ source: a, target: bc });
    eventSourceMapping({ source: ab, target: c });
    route(api({ id: "a" }), "GET", "/x", undefined, bc);
    route(api({ id: "a-b" }), "GET", "/x", undefined, c);
  });

  expect(duplicateIds(graph)).toEqual([]);
  expect(graph.resources.map((resource) => resource.id)).toEqual(
    expect.arrayContaining([
      "sqs-mapping:a:b-c",
      "sqs-mapping:a-b:c",
      "api-integration:a:b-c",
      "api-integration:a-b:c",
      "api-invoke-permission:a:b-c",
      "api-invoke-permission:a-b:c",
    ]),
  );
});
