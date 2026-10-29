import pako from "pako";
import { fromUint8Array } from "js-base64";
import { ResourceGroup } from "../orchestrator/resource-group";
import { BaseResource } from "../orchestrator/resource";

// Mermaid IDs can't hold characters that resource and group names may use,
// such as the spaces in an API name or the braces in a `/todos/{id}` route,
// and replacing those characters could make two names collide. So nodes and subgraphs get IDs from their position in the chart,
// and the names go in quoted labels.
export const createMermaidFlowChart = (
  resourceGroups: ResourceGroup[],
  resources: BaseResource[],
): string => {
  let mermaidString = "flowchart TD\n";
  let connectionsString = "";
  const nodeIds = new Map<string, string>();
  const drawn: BaseResource[] = [];

  const drawResource = (resource: BaseResource, indent: string) => {
    const nodeId = `r${drawn.length}`;
    nodeIds.set(resource.id, nodeId);
    drawn.push(resource);
    mermaidString += `${indent}${nodeId}(${label(`${resource.type} ${resource.id}`)})\n`;
  };

  resourceGroups.forEach((group, index) => {
    mermaidString += `  subgraph g${index}[${label(`${group.type} ${group.id}`)}]\n`;
    group.resources.forEach((resource) => drawResource(resource, "    "));
    mermaidString += `  end\n`;
  });

  resources
    .filter((resource) => !nodeIds.has(resource.id))
    .forEach((resource) => drawResource(resource, "  "));

  drawn.forEach((resource) => {
    Object.values(resource.dependencies).forEach((dep) => {
      if (!dep) return;
      const depNodeId = nodeIds.get(dep.id);
      if (depNodeId) {
        connectionsString += `  ${nodeIds.get(resource.id)} --> ${depNodeId}\n`;
      }
    });
  });

  return `${mermaidString}\n${connectionsString}`;
};

// A quoted Mermaid label. Quotes and the characters Mermaid reads as markup
// are written as entity codes; "#" goes first, as it starts every code.
function label(text: string) {
  const escaped = text
    .replaceAll("#", "#35;")
    .replaceAll('"', "#quot;")
    .replaceAll("`", "#96;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;");
  return `"${escaped}"`;
}

export function createMermaidLiveUrl(mermaidCode: string) {
  const state = {
    code: mermaidCode,
    mermaid: JSON.stringify({ theme: "default" }, undefined, 2),
    autoSync: true,
    updateDiagram: true,
  };
  const json = JSON.stringify(state);
  const data = new TextEncoder().encode(json);
  const compressed = pako.deflate(data, { level: 9 });
  const string = fromUint8Array(compressed, true);
  return `https://mermaid.live/view#pako:${string}`;
}
