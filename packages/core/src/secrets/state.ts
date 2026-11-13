import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseResource } from "@notation/resource";
import type { Redacted } from "./redacted";

export type ExecutionContext = {
  stage: string;
  executionId: string;
  promptHandler?: SecretPromptHandler;
  secretValues?: Map<string, Redacted<string>>;
};

export type ExecutionContextStore = Partial<ExecutionContext>;

export type SecretSource = {
  /** Shown in plan, and stored in the value resource's params, such as "infisical". */
  name: string;
  /** True if the source has a value for the key. */
  has(key: string, context: { stage: string }): Promise<boolean>;
  /** The key's version. Left out by sources that have no versions. */
  version?(key: string, context: { stage: string }): Promise<string>;
  get(key: string, context: { stage: string }): Promise<Redacted<string>>;
};

export type SecretTarget = {
  /** Logical secret ID (e.g. "stripe-key"), as used in `notation secret set <id>`. */
  id: string;
  /** The underlying secret resource (e.g. SecretsStoreSecret or AccountToken). */
  resource: BaseResource;
  /** The source object, if the secret has a source. */
  source?: SecretSource;
  /** The key in the source, if the secret has a source. */
  key?: string;
  /** True for token declarations whose value can only be written by token creation. */
  isToken?: boolean;
};

export type SecretPromptContext = {
  id: string;
  stage: string;
};

export type SecretPromptHandler = (
  context: SecretPromptContext,
) => Promise<string | Redacted<string>>;

type SecretsState = {
  executionContextStorage: AsyncLocalStorage<ExecutionContextStore>;
  recordedSecrets: Set<string>;
  secretTargets: Map<string, SecretTarget>;
};

const STATE_KEY = Symbol.for("@notation/core/secrets-state");

export function getSecretsState(): SecretsState {
  const globalStore = globalThis as { [STATE_KEY]?: SecretsState };
  if (!globalStore[STATE_KEY]) {
    globalStore[STATE_KEY] = {
      executionContextStorage: new AsyncLocalStorage(),
      recordedSecrets: new Set(),
      secretTargets: new Map(),
    };
  }
  return globalStore[STATE_KEY];
}
