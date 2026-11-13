import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseResource } from "@notation/resource";
import type { Redacted } from "./redacted";

/** What a source is told when it is asked for a key. */
export type SourceContext = { stage: string };

/**
 * Says how to read secret values from one place, such as `process.env`, a
 * `.env` file or a secrets manager. A source's own credentials come from
 * `process.env`. A source may cache what it reads within one process.
 */
export type Source = {
  /** Shown in plan, and stored in the value resource's params, such as "infisical". */
  name: string;
  /** True if the source has a value for the key. */
  has(key: string, context: SourceContext): Promise<boolean>;
  /**
   * The key's version, a number or ID that the source assigns. It is never
   * derived from the value. Left out by sources that have no versions, and
   * `undefined` for a key that has none. Without a version, the run ID
   * stands in, so the value is written on every deploy.
   */
  version?(key: string, context: SourceContext): Promise<string | undefined>;
  get(key: string, context: SourceContext): Promise<Redacted<string>>;
};

/**
 * The source name that a secret without a source records, as its value comes
 * from the prompt.
 */
export const PROMPT_SOURCE = "prompt";

/** A secret that the infra declares, by its id. */
export type DeclaredSecret = {
  id: string;
  /**
   * The resource that writes the secret's value.
   * `notation secret set` and `notation secret delete` call its operations.
   */
  resource: BaseResource;
  /** Where the value comes from. Without a source, deploy asks for it. */
  source?: Source;
  key?: string;
  /** Set when `notation secret set` refuses the secret, with the reason. */
  refuseSet?: string;
  /** Set when `notation secret delete` refuses the secret, with the reason. */
  refuseDelete?: string;
};

/** Asks a person for the value of a secret that has no source. */
export type SecretPrompt = (request: {
  id: string;
  stage: string;
}) => Promise<string>;

export type SecretContextOptions = {
  stage: string;
  /**
   * Changes on every run: the execution ID of a deploy, or a new ID for each
   * plan. It stands in for the version of a source that has none.
   */
  runId: string;
  /** Unset when no one can answer, such as in CI or with `--json`. */
  prompt?: SecretPrompt;
  /**
   * The value that `notation secret set` writes. `getValue` returns it for
   * the secret with this id, in place of its source or the prompt.
   */
  supplied?: { id: string; value: Redacted<string> };
};

export type SecretContext = SecretContextOptions & {
  /** The secrets that the infra declared while the graph was collected. */
  declared: Map<string, DeclaredSecret>;
  /**
   * The prompt's answers, by secret id. They are kept for the run, so that a
   * create or update that is retried doesn't ask again.
   */
  prompted: Map<string, Redacted<string>>;
};

// On globalThis, so that the infra bundle's copy of this package and the
// CLI's copy share the context.
const storageKey = Symbol.for("@notation/core/secret-context");

function storage(): AsyncLocalStorage<SecretContext> {
  const holder = globalThis as {
    [storageKey]?: AsyncLocalStorage<SecretContext>;
  };
  holder[storageKey] ??= new AsyncLocalStorage();
  return holder[storageKey];
}

/**
 * Runs `fn` with a secret context. The infra is evaluated inside it, so that
 * its secret declarations are recorded, and resource operations read secret
 * values through it.
 */
export function runWithSecretContext<T>(
  options: SecretContextOptions,
  fn: () => T,
): T {
  return storage().run(
    { ...options, declared: new Map(), prompted: new Map() },
    fn,
  );
}

export function secretContext(): SecretContext | undefined {
  return storage().getStore();
}

/**
 * Records a secret that the infra declares, so that `getValue` and
 * `notation secret set` find it by its id. Does nothing outside a secret
 * context, such as in `notation viz`. It is an engine mechanism for resource
 * packages, not user-facing API.
 */
export function declareSecret(secret: DeclaredSecret): void {
  const declared = secretContext()?.declared;
  if (!declared) return;
  if (declared.has(secret.id)) {
    throw new Error(
      `Two secrets have the id "${secret.id}". \`notation secret set\` finds a secret by its id, so give one of them another id.`,
    );
  }
  declared.set(secret.id, secret);
}
