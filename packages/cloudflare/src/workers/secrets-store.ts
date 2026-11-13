import type { BindableSecret, SecretsStoreSecretBinding } from "./declaration";

// The runtime build also loads this module, so it must only import types.

/** Binds secrets of the account's Secrets Store to a Worker. */
export const secretsStore = {
  /**
   * Binds a secret from `secret()` or `accountToken()`. In the Worker, the
   * binding is a `SecretsStoreSecret`, so the code reads the value with
   * `await env.NAME.get()`. The Worker is uploaded after the secret exists.
   */
  bind(secret: BindableSecret): SecretsStoreSecretBinding {
    return { "~secretsStoreSecret": secret };
  },
};

export function boundSecret(value: unknown): BindableSecret | undefined {
  return typeof value === "object" &&
    value !== null &&
    "~secretsStoreSecret" in value
    ? (value as SecretsStoreSecretBinding)["~secretsStoreSecret"]
    : undefined;
}
