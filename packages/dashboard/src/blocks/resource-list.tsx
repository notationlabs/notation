import { ResourceGroupRef } from "@notation/core";
import type { DashboardResource } from "../hooks/remote-state";

export function ResourceList(props: {
  resources: DashboardResource[];
  activeResourceId?: string;
  onClick: (resource: DashboardResource) => void;
}) {
  return (
    <div className="flex h-full bg-neutral-50 hover:overflow-auto">
      <ul>
        {aggregateResources(props.resources).map((resourceGroup) => (
          <ul key={resourceGroup.key} className="mt-3 mb-5">
            <li className="px-4 py-2 text-xs text-gray-500 font-semibold">
              {resourceGroup.group
                ? `${resourceGroup.group.type} ${resourceGroup.group.id}`
                : "Ungrouped"}
            </li>
            <ul>
              {resourceGroup.resources.map((resource) => (
                <li
                  key={resource.id}
                  className={`text-sm px-4 py-2.5 pt-2 hover:bg-blue-100 cursor-pointer ${
                    props.activeResourceId === resource.id ? "bg-stone-200" : ""
                  }`}
                  onClick={() => props.onClick(resource)}
                >
                  <code className="text-xs">{resource.id}</code>
                  {resource.retired?.length ? (
                    <span className="ml-2 text-xs text-amber-600">
                      {resource.retired.length} retired
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </ul>
        ))}
      </ul>
    </div>
  );
}

type ResourceListGroup = {
  key: string;
  group: ResourceGroupRef | null;
  resources: DashboardResource[];
};

// group IDs are unique within a type, so a group is keyed by both; resources
// in no group are listed last
function aggregateResources(resources: DashboardResource[]) {
  const groups = new Map<string, ResourceListGroup>();
  resources.forEach((resource) => {
    const { group } = resource;
    const key = group ? `${group.type}:${group.id}` : "ungrouped";
    if (!groups.has(key)) {
      groups.set(key, { key, group, resources: [] });
    }
    groups.get(key)!.resources.push(resource);
  });
  return [...groups.values()].sort((a, b) => {
    if (!a.group || !b.group) return a.group ? -1 : b.group ? 1 : 0;
    return (
      a.group.type.localeCompare(b.group.type) ||
      a.group.id.localeCompare(b.group.id)
    );
  });
}
