import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ResourceType = `${string}/${string}/${string}`;

export type StateNode = {
  id: string;
  groupId: number;
  groupType: string;
  type: ResourceType;
  config: Record<string, any>;
  params: Record<string, any>;
  output: Record<string, any>;
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

export type StateStoreOptions = {
  /**
   * Path to the state file.
   *
   * Defaults to "./.notation/state.json".
   */
  filePath?: string;
};

export class State {
  #filePath: string;
  #state: Record<string, StateNode>;

  constructor(opts: StateStoreOptions = {}) {
    this.#filePath = opts.filePath ?? "./.notation/state.json";
    this.#state = {};
  }

  async get(id: string) {
    this.#state = await readState(this.#filePath);
    return this.#state[id];
  }

  async has(id: string) {
    this.#state = await readState(this.#filePath);
    return !!this.#state[id];
  }

  async update(id: string, patch: Partial<StateNode>) {
    this.#state = await readState(this.#filePath);
    this.#state[id] = {
      ...this.#state[id],
      ...patch,
    } as StateNode;
    await writeState(this.#filePath, this.#state);
  }

  async delete(id: string) {
    this.#state = await readState(this.#filePath);
    delete this.#state[id];
    await writeState(this.#filePath, this.#state);
  }

  async values() {
    this.#state = await readState(this.#filePath);
    return Object.values(this.#state);
  }
}

async function readState(filePath: string): Promise<Record<string, StateNode>> {
  if (await pathExists(filePath)) {
    const rawContent = await readFile(filePath, "utf8");
    if (rawContent.trim().length === 0) {
      return {};
    }
    const raw = JSON.parse(rawContent) as Record<string, any>;
    return normalizeState(raw);
  }

  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify({}, null, 2));
  return {};
}

async function writeState(filePath: string, state: Record<string, StateNode>) {
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(state, null, 2));
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(filePath: string) {
  await mkdir(dirname(filePath), { recursive: true });
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
