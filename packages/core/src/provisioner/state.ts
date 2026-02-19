import fsExtra from "fs-extra/esm";
import type { ResourceType } from "src/orchestrator/resource";

export type StateNode = {
  id: string;
  groupId: number;
  groupType: string;
  type: ResourceType;
  config: {};
  params: {};
  output: {};
  lastOperation: "drift" | "create" | "update" | "delete";
  lastOperationAt: string;
};

type LegacyStateNodeMeta = {
  moduleName: string;
  serviceName: string;
  resourceName: string;
};

type LegacyStateNode = Omit<StateNode, "type"> & {
  meta: LegacyStateNodeMeta;
  type?: never;
};

export class State {
  state: Record<string, StateNode>;
  constructor() {
    this.state = {};
  }
  async get(id: string) {
    this.state = await readState();
    return this.state[id];
  }
  async has(id: string) {
    this.state = await readState();
    return !!this.state[id];
  }
  async update(id: string, patch: Partial<StateNode>) {
    this.state = await readState();
    this.state[id] = {
      ...this.state[id],
      ...patch,
    };
    await writeState(this.state);
  }
  async delete(id: string) {
    this.state = await readState();
    delete this.state[id];
    await writeState(this.state);
  }
  async values() {
    this.state = await readState();
    return Object.values(this.state);
  }
}

async function readState(): Promise<Record<string, StateNode>> {
  const filePath = "./.notation/state.json";

  if (await fsExtra.pathExists(filePath)) {
    const raw = (await fsExtra.readJSON(filePath)) as Record<string, any>;
    return normalizeState(raw);
  } else {
    await fsExtra.ensureFile(filePath);
    await fsExtra.writeJSON(filePath, {});
    return {};
  }
}

async function writeState(state: Record<string, StateNode>) {
  await fsExtra.ensureDir("./.notation");
  await fsExtra.ensureFile("./.notation/state.json");
  await fsExtra.writeJSON("./.notation/state.json", state, { spaces: 2 });
}

function normalizeState(state: Record<string, any>): Record<string, StateNode> {
  const normalized: Record<string, StateNode> = {};

  for (const [id, node] of Object.entries(state)) {
    if (!node || typeof node !== "object") continue;
    normalized[id] = normalizeStateNode(node);
  }

  return normalized;
}

function normalizeStateNode(node: any): StateNode {
  // Preferred format: already has `type`.
  if (typeof node.type === "string") {
    // Drop any lingering legacy `meta` fields if present.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { meta: _meta, ...rest } = node;
    return rest as StateNode;
  }

  // Legacy format: `meta` exists but `type` is missing.
  if (node.meta && typeof node.meta === "object") {
    const legacy = node as LegacyStateNode;
    const type = legacyMetaToType(legacy.meta);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { meta: _meta, ...rest } = legacy as any;
    return { ...rest, type } as StateNode;
  }

  throw new Error(
    `Invalid state node: missing "type" (and no legacy "meta" to derive it). Node id: ${
      node.id ?? "<unknown>"
    }`,
  );
}

function legacyMetaToType(meta: LegacyStateNodeMeta): ResourceType {
  const match = /^@notation\/([^/]+)\.iac$/.exec(meta.moduleName);
  if (!match) {
    throw new Error(
      `Cannot derive resource type from legacy meta.moduleName "${meta.moduleName}". ` +
        `Expected format "@notation/<provider>.iac".`,
    );
  }
  const provider = match[1]!;
  return `${provider}/${meta.serviceName}/${meta.resourceName}` as ResourceType;
}
