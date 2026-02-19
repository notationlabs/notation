export type StateNode = {
  id: string;
  groupId: number;
  groupType: string;
  type: string;
  config: Record<string, unknown>;
  params: Record<string, unknown>;
  output: Record<string, unknown>;
  lastOperation: "drift" | "create" | "update" | "delete";
  lastOperationAt: string;
  [key: string]: unknown;
};

export interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  has(id: string): Promise<boolean>;
  update(id: string, patch: Partial<StateNode>): Promise<void>;
  delete(id: string): Promise<void>;
  values(): Promise<StateNode[]>;
};

export type State = StateBackend;
