import { expect, it } from "vitest";
import {
  accountId,
  api,
  describeE2e,
  secretsWithPrefix,
  tokensWithPrefix,
  useProject,
  type AccountTokenSummary,
} from "../e2e";

describeE2e("cloudflare/tokens/AccountToken", () => {
  const project = useProject({ stage: "token", accountTokens: true });
  const name = `${project.scope}raw`;

  // A deployment declares resources only through a group, so the token sits
  // in one, with the account's Secrets Store as its dependency.
  function writeInfra(config: string) {
    project.write(
      "infra/main.ts",
      `
      import { ResourceGroup } from "@notation/resource";
      import * as cloudflare from "@notation/cloudflare/resources";
      import { SecretsStoreGroup } from "@notation/cloudflare/secrets-store";

      class TokenGroup extends ResourceGroup {
        constructor() {
          super("e2e/token", "raw");
          const { store } = new SecretsStoreGroup();
          this.add(
            new cloudflare.tokens.AccountToken("token:raw", {
              config: {
                Name: "${name}",
                Policies: [
                  {
                    effect: "allow",
                    permissionGroups: ["Account Settings Read"],
                    resources: { "com.cloudflare.api.account.${accountId}": "*" },
                  },
                ],
                ${config}
              },
              dependencies: { store },
            }),
          );
        }
      }

      new TokenGroup();
      `,
    );
  }

  // The list leaves out a token's condition and times when they are empty,
  // so the token is read on its own.
  async function theToken(): Promise<AccountTokenSummary> {
    const tokens = await tokensWithPrefix(name);
    expect(tokens.map((token) => token.name)).toEqual([name]);
    const response = await api<AccountTokenSummary>(
      "GET",
      `/tokens/${tokens[0]!.id}`,
    );
    expect(response.errors).toEqual([]);
    return response.result;
  }

  const seconds = (time: string | null | undefined) =>
    time ? `${new Date(time).toISOString().slice(0, 19)}Z` : time;

  let tokenId: string;

  it("creates the token with its policies, IP ranges and times", async () => {
    writeInfra(`
      Condition: { requestIp: { in: ["198.51.100.0/24", "192.0.2.0/24"], notIn: ["192.0.2.1/32"] } },
      ExpiresOn: "2030-01-01T00:00:00Z",
      NotBefore: "2026-01-01T00:00:00.250Z",
    `);
    await project.notation("deploy");

    const token = await theToken();
    tokenId = token.id;
    expect(token.status).toBe("active");
    expect(token.policies).toHaveLength(1);
    expect(token.policies[0]).toMatchObject({
      effect: "allow",
      permission_groups: [{ name: "Account Settings Read" }],
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    });
    expect([...(token.condition?.request_ip?.in ?? [])].sort()).toEqual([
      "192.0.2.0/24",
      "198.51.100.0/24",
    ]);
    expect(token.condition?.request_ip?.not_in).toEqual(["192.0.2.1/32"]);
    expect(seconds(token.expires_on)).toBe("2030-01-01T00:00:00Z");
    expect(seconds(token.not_before)).toBe("2026-01-01T00:00:00Z");
    expect(await secretsWithPrefix(name)).toMatchObject([{ name }]);
  });

  it("leaves the token alone on a deploy with the same config", async () => {
    const before = await theToken();
    await project.notation("deploy");

    expect((await theToken()).modified_on).toBe(before.modified_on);
  });

  it("updates the IP ranges and times in place", async () => {
    writeInfra(`
      Condition: { requestIp: { notIn: ["203.0.113.0/24"] } },
      ExpiresOn: "2031-06-01T12:30:00Z",
      NotBefore: "2026-02-01T00:00:00Z",
    `);
    await project.notation("deploy");

    const token = await theToken();
    expect(token.id).toBe(tokenId);
    expect(token.condition?.request_ip?.in ?? []).toEqual([]);
    expect(token.condition?.request_ip?.not_in).toEqual(["203.0.113.0/24"]);
    expect(seconds(token.expires_on)).toBe("2031-06-01T12:30:00Z");
    expect(seconds(token.not_before)).toBe("2026-02-01T00:00:00Z");
  });

  it("removes the IP ranges and times when the config drops them", async () => {
    writeInfra("");
    await project.notation("deploy");

    const token = await theToken();
    expect(token.id).toBe(tokenId);
    expect(token.status).toBe("active");
    expect(token.condition?.request_ip?.in ?? []).toEqual([]);
    expect(token.condition?.request_ip?.not_in ?? []).toEqual([]);
    expect(token.expires_on ?? undefined).toBeUndefined();
    expect(token.not_before ?? undefined).toBeUndefined();
  });

  it("deletes the token and its secret on destroy", async () => {
    await project.notation("destroy");

    expect(await tokensWithPrefix(name)).toEqual([]);
    expect(await secretsWithPrefix(name)).toEqual([]);
  });
});
