import type { ResourceGroupId } from "@notation/core";
import type { DashboardResource } from "../hooks/remote-state";

type ResourceListProps = {
  resources: DashboardResource[];
  activeResourceId?: string;
  onClick: (resource: DashboardResource) => void;
};

export function ResourceList(props: ResourceListProps) {
  const { groups, ungrouped } = buildGroupTree(props.resources);
  return (
    <div className="flex h-full bg-neutral-50 hover:overflow-auto">
      <ul>
        {groups.map((node) => (
          <GroupNode {...props} key={node.key} node={node} depth={0} />
        ))}
        {ungrouped.length > 0 ? (
          <ul className="mt-3 mb-5">
            <li className="px-4 py-2 text-xs text-gray-500 font-semibold">
              Ungrouped
            </li>
            <Resources {...props} resources={ungrouped} depth={0} />
          </ul>
        ) : null}
      </ul>
    </div>
  );
}

function GroupNode(
  props: ResourceListProps & { node: GroupTreeNode; depth: number },
) {
  const { node, depth } = props;
  return (
    <ul className={depth === 0 ? "mt-3 mb-5" : "mt-1"}>
      <li
        className="py-2 pr-4 text-xs text-gray-500 font-semibold"
        style={{ paddingLeft: indent(depth) }}
      >
        {`${node.group.type} ${node.group.id}`}
      </li>
      <Resources {...props} resources={node.resources} depth={depth + 1} />
      {node.children.map((child) => (
        <GroupNode {...props} key={child.key} node={child} depth={depth + 1} />
      ))}
    </ul>
  );
}

function Resources(
  props: ResourceListProps & { resources: DashboardResource[]; depth: number },
) {
  return (
    <ul>
      {props.resources.map((resource) => (
        <li
          key={resource.id}
          className={`text-sm pr-4 py-2.5 pt-2 hover:bg-blue-100 cursor-pointer ${
            props.activeResourceId === resource.id ? "bg-stone-200" : ""
          }`}
          style={{ paddingLeft: indent(props.depth) }}
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
  );
}

// Tailwind's px-4, plus a step for each level of nesting.
function indent(depth: number) {
  return `${1 + depth * 0.75}rem`;
}

type GroupTreeNode = {
  key: string;
  group: ResourceGroupId;
  resources: DashboardResource[];
  children: GroupTreeNode[];
};

// Group IDs are unique within a type, so a group is keyed by both. Each
// resource's group ref lists the groups that contain it, from the outermost,
// so the tree is built from the refs alone. Groups are sorted by type and
// then ID at each level.
function buildGroupTree(resources: DashboardResource[]) {
  const roots: GroupTreeNode[] = [];
  const nodes = new Map<string, GroupTreeNode>();
  const ungrouped: DashboardResource[] = [];

  const nodeFor = (path: ResourceGroupId[]) => {
    let siblings = roots;
    let node: GroupTreeNode | undefined;
    for (const group of path) {
      const key = `${group.type}:${group.id}`;
      node = nodes.get(key);
      if (!node) {
        node = { key, group, resources: [], children: [] };
        nodes.set(key, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    return node!;
  };

  resources.forEach((resource) => {
    const { group } = resource;
    if (!group) {
      ungrouped.push(resource);
      return;
    }
    nodeFor([...(group.parents ?? []), group]).resources.push(resource);
  });

  const sort = (list: GroupTreeNode[]) => {
    list.sort(
      (a, b) =>
        a.group.type.localeCompare(b.group.type) ||
        a.group.id.localeCompare(b.group.id),
    );
    list.forEach((node) => sort(node.children));
  };
  sort(roots);

  return { groups: roots, ungrouped };
}
