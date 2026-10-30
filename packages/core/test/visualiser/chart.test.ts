import { expect, it } from "vitest";
import { stripIndent } from "common-tags";
import {
  createMermaidFlowChart,
  createMermaidLiveUrl,
} from "src/visualiser/chart";
import { ResourceGroup } from "src/orchestrator/resource-group";
import { BaseResource } from "src/orchestrator/resource";

it("should create a mermaid flowchart string", () => {
  const { resourceGroups, resources } = getFixture();
  const chart = createMermaidFlowChart(resourceGroups, resources);

  const expected = stripIndent`
    flowchart TD
      subgraph g0["GroupTypeA a"]
        r0("ResourceTypeA resource-a")
        r1("ResourceTypeB resource-b")
      end
      subgraph g1["GroupTypeB b"]
        r2("ResourceTypeC resource-c")
      end

      r1 --> r0`;

  expect(chart).toBe(expected + "\n");
});

it("keeps names that Mermaid can't use as IDs in quoted labels", () => {
  const api = fakeResource("Todo API", "aws/apiGateway/api");
  const route = fakeResource(
    "Todo API-GET-/todos/{id}",
    "aws/apiGateway/route",
    { api },
  );
  const quoted = fakeResource('say "hi" #1 <b>`x`</b>', "test/quoted");
  const chart = createMermaidFlowChart(
    [
      fakeGroup("API Gateway", "Todo API", [api]),
      fakeGroup("API Gateway/Route", "Todo API-GET-/todos/{id}", [route]),
      fakeGroup("Test", "quoted", [quoted]),
    ],
    [api, route, quoted],
  );

  const expected = stripIndent`
    flowchart TD
      subgraph g0["API Gateway Todo API"]
        r0("aws/apiGateway/api Todo API")
      end
      subgraph g1["API Gateway/Route Todo API-GET-/todos/{id}"]
        r1("aws/apiGateway/route Todo API-GET-/todos/{id}")
      end
      subgraph g2["Test quoted"]
        r2("test/quoted say #quot;hi#quot; #35;1 #lt;b#gt;#96;x#96;#lt;/b#gt;")
      end

      r1 --> r0`;

  expect(chart).toBe(expected + "\n");
});

it("gives distinct nodes to names that differ only in punctuation", () => {
  const slash = fakeResource("a/b", "test/resource");
  const underscore = fakeResource("a_b", "test/resource");
  const chart = createMermaidFlowChart(
    [fakeGroup("Test", "group", [slash, underscore])],
    [slash, underscore],
  );

  expect(chart).toContain('r0("test/resource a/b")');
  expect(chart).toContain('r1("test/resource a_b")');
});

it("draws resources that are in no group outside every subgraph", () => {
  const grouped = fakeResource("grouped", "test/resource");
  const ungrouped = fakeResource("ungrouped", "test/resource", { grouped });
  const chart = createMermaidFlowChart(
    [fakeGroup("Test", "group", [grouped])],
    [grouped, ungrouped],
  );

  const expected = stripIndent`
    flowchart TD
      subgraph g0["Test group"]
        r0("test/resource grouped")
      end
      r1("test/resource ungrouped")

      r1 --> r0`;

  expect(chart).toBe(expected + "\n");
});

it("should create a mermaid live URL from given code", () => {
  const mermaidCode = "flowchart TD\nA --> B";
  const result = createMermaidLiveUrl(mermaidCode);
  const expected =
    "https://mermaid.live/view#pako:eNolyksKhDAQRdGtFG-sG8igQXEH9rAmRVJ-wCRNqNCIuHcDzi6Xc8HnoHBYjvz3mxSj78RpoL7_0IgOUUuUPTRxcSJi2KZRGa5l0EXqYQxOd6NSLc9n8nBWqnaovyCm0y5rkfjO-wHolSVC";
  expect(result).toBe(expected);
});

function fakeResource(
  id: string,
  type: string,
  dependencies: Record<string, BaseResource> = {},
) {
  return {
    id,
    type,
    config: {},
    dependencies,
    getDependencies: () =>
      Object.values(dependencies).filter((dep): dep is BaseResource =>
        Boolean(dep),
      ),
  } as unknown as BaseResource;
}

function fakeGroup(type: string, id: string, resources: BaseResource[]) {
  for (const resource of resources) resource.group = { type, id };
  return { type, id, config: {}, resources } as unknown as ResourceGroup;
}

function getFixture() {
  const resourceA = fakeResource("resource-a", "ResourceTypeA");
  const resourceB = fakeResource("resource-b", "ResourceTypeB", {
    dep1: resourceA,
  });
  const resourceC = fakeResource("resource-c", "ResourceTypeC");

  const resourceGroups = [
    fakeGroup("GroupTypeA", "a", [resourceA, resourceB]),
    fakeGroup("GroupTypeB", "b", [resourceC]),
  ];
  const resources = [resourceA, resourceB, resourceC];

  return { resourceGroups, resources };
}
