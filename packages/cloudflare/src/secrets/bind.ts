import type { BindableSecret, SecretBinding } from "src/workers/declaration";

/**
 * Binds Secrets Store secrets (from `secret()` or `accountToken()`) to a
 * Cloudflare Worker via `$worker({ bindings: () => ({ ... }) })`.
 */
export const secretsStore = {
  /**
   * Creates a `secrets_store_secret` binding for `secret`. In the Worker
   * handler, `env.<NAME>` is typed `cf.SecretsStoreSecret` and read with
   * `await env.<NAME>.get()`.
   */
  bind(secret: BindableSecret): SecretBinding {
    return {
      "~secretBinding": secret,
    };
  },
};
