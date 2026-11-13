import type { BindableSecret, SecretBinding } from "./workers/declaration";
import type { AccountTokenConfig } from "./secrets/account-token";
import type { SecretConfig } from "./secrets/secret";

// The runtime build resolves `@notation/cloudflare` to this module via the
// `notation-runtime` export condition, so it exports the same names as
// `src/index.ts` without any infrastructure code.

export * from "./workers/runtime";
export type {
  AccountTokenConfig,
  AccountTokenPolicy,
} from "./secrets/account-token";
export type { SecretConfig } from "./secrets/secret";

const infraOnly = (name: string) =>
  new Error(`${name} declares infrastructure, so it can't run in a Worker.`);

export function secret<const Id extends string>(
  _config: SecretConfig<Id>,
): BindableSecret {
  throw infraOnly("secret()");
}

export function accountToken<const Id extends string>(
  _config: AccountTokenConfig<Id>,
): BindableSecret {
  throw infraOnly("accountToken()");
}

export const secretsStore = {
  bind(_secret: BindableSecret): SecretBinding {
    throw infraOnly("secretsStore.bind()");
  },
};
