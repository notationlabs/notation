import { expect, it } from "vitest";
import {
  accountId,
  api,
  describeE2e,
  poll,
  secretsWithPrefix,
  tokensWithPrefix,
  useProject,
  type AccountTokenSummary,
  type Fetched,
} from "../e2e";

type Probe = {
  sha256: string;
  // The token's status, from Cloudflare's verify endpoint.
  status: string | null;
  // Whether the token could read the account.
  accountRead: boolean;
  // The error codes of the account read.
  codes: number[];
};

describeE2e("a Worker that binds a SecretsStoreSecret", () => {
  const project = useProject({ accountTokens: true });
  // Deploy names the token and its secrets from their ids, with an instance.
  const name = `${project.scope}probe-token-`;
  const accountResource = `com.cloudflare.api.account.${accountId}`;

  // `more` is code that follows the token's declaration.
  function writeInfra(options: string, more = "") {
    project.write(
      "infra/tokens.ts",
      `
      import * as cloudflare from "@notation/cloudflare/resources";

      const store = new cloudflare.secretsStore.SecretsStore("secrets-store");

      const probeToken = new cloudflare.tokens.AccountToken("probe-token", {
        config: { ${options} },
      });

      export const probeTokenSecret = new cloudflare.secretsStore.SecretsStoreSecret(
        "probe-token-secret",
        { config: { Value: probeToken.credentials.Value }, dependencies: { store } },
      );
      ${more}
      `,
    );
  }

  // A second secret that takes the token's value.
  const copySecret = `
    new cloudflare.secretsStore.SecretsStoreSecret("probe-token-copy", {
      config: { Value: probeToken.credentials.Value },
      dependencies: { store },
    });
  `;

  // The Worker reads the token from its binding, verifies it, and reads the
  // account with it. It returns a hash of the value, so that the test can
  // see that the value stays the same without seeing the value.
  function writeWorker() {
    project.write(
      "runtime/probe.ts",
      `
      import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
      import { probeTokenSecret } from "../infra/tokens";

      export const worker = $worker({
        id: "probe",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ TOKEN: probeTokenSecret, ACCOUNT_ID: "${accountId}" }),
      });

      export default {
        async fetch(request, env) {
          const value = await env.TOKEN.get();
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
          const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
          const call = async (path: string) => {
            const response = await fetch(
              \`https://api.cloudflare.com/client/v4/accounts/\${env.ACCOUNT_ID}\${path}\`,
              { headers: { Authorization: \`Bearer \${value}\` } },
            );
            const body: any = await response.json();
            return { body, codes: (body.errors ?? []).map((error: any) => error.code) };
          };
          const verify = await call("/tokens/verify");
          const account = await call("");
          return Response.json({
            sha256,
            status: verify.body.result?.status ?? null,
            accountRead: account.body.success === true,
            codes: account.codes,
          });
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );
  }

  const policy = (groups: string[]) => `
    {
      effect: "allow",
      permissionGroups: ${JSON.stringify(groups)},
      resources: { "${accountResource}": "*" },
    }`;

  async function theToken(): Promise<AccountTokenSummary> {
    const tokens = await tokensWithPrefix(name);
    expect(tokens.map((token) => token.name)).toEqual([
      expect.stringMatching(/^[^.]+-[0-9a-f]{8}$/),
    ]);
    const response = await api<AccountTokenSummary>(
      "GET",
      `/tokens/${tokens[0]!.id}`,
    );
    expect(response.errors).toEqual([]);
    return response.result;
  }

  async function probe(done: (probe: Probe) => boolean): Promise<Probe> {
    const parse = (fetched: Fetched): Probe | undefined => {
      try {
        return fetched.ok ? JSON.parse(fetched.body!) : undefined;
      } catch {
        return undefined;
      }
    };
    const workers = await project.workerNames();
    const worker = workers.find((w) => w.startsWith(`${project.scope}probe-`));
    expect(worker, `no probe Worker in ${workers}`).toBeDefined();
    const fetched = await poll(project.url(worker!), {
      done: (fetched) => {
        const parsed = parse(fetched);
        return parsed !== undefined && done(parsed);
      },
    });
    const parsed = parse(fetched);
    expect(parsed, JSON.stringify(fetched)).toBeDefined();
    return parsed!;
  }

  const works = (probe: Probe) =>
    probe.status === "active" && probe.accountRead;

  let tokenId: string;
  let sha256: string;

  it("creates a token with its condition, and binds its value to a Worker", async () => {
    writeInfra(`
      Policies: [${policy(["Account Settings Read"])}],
      Condition: { requestIp: { notIn: ["192.0.2.0/24"] } },
    `);
    writeWorker();
    await project.notation("deploy");

    const token = await theToken();
    tokenId = token.id;
    expect(token.status).toBe("active");
    expect(token.condition?.request_ip?.not_in).toEqual(["192.0.2.0/24"]);
    expect(token.expires_on ?? undefined).toBeUndefined();
    expect(await secretsWithPrefix(`${name}secret-`)).toHaveLength(1);

    const result = await probe(works);
    expect(result).toMatchObject({
      status: "active",
      accountRead: true,
      codes: [],
    });
    sha256 = result.sha256;
  });

  it("updates the policies and condition in place, and the token keeps its value", async () => {
    writeInfra(`
      Policies: [${policy(["Account Settings Read", "Workers Scripts Read"])}],
      Condition: { requestIp: { in: ["192.0.2.0/24"] } },
    `);
    await project.notation("deploy");

    const token = await theToken();
    expect(token.id).toBe(tokenId);
    expect(
      token.policies.flatMap((p) => p.permission_groups.map((g) => g.name)),
    ).toEqual(
      expect.arrayContaining(["Account Settings Read", "Workers Scripts Read"]),
    );
    expect(token.condition?.request_ip?.in).toEqual(["192.0.2.0/24"]);
    expect(token.condition?.request_ip?.not_in ?? []).toEqual([]);

    // The Worker's requests don't come from 192.0.2.0/24, so Cloudflare
    // now rejects the token.
    const result = await probe((probe) => !probe.accountRead);
    expect(result).toMatchObject({ accountRead: false, sha256 });
  });

  it("removes the condition, and the token works again with the same value", async () => {
    writeInfra(`Policies: [${policy(["Account Settings Read"])}],`);
    await project.notation("deploy");

    const token = await theToken();
    expect(token.id).toBe(tokenId);
    expect(token.condition?.request_ip?.in ?? []).toEqual([]);
    expect(token.condition?.request_ip?.not_in ?? []).toEqual([]);

    const result = await probe(works);
    expect(result).toMatchObject({
      status: "active",
      accountRead: true,
      codes: [],
      sha256,
    });
  });

  // Deploy no longer holds the token's value, so the new secret can only get
  // one by a roll of the token.
  it("rolls the token when a second secret takes its value, and updates the first secret", async () => {
    writeInfra(`Policies: [${policy(["Account Settings Read"])}],`, copySecret);
    await project.notation("deploy");

    const token = await theToken();
    expect(token.id).toBe(tokenId);
    expect(
      (await secretsWithPrefix(name)).map((secret) => secret.name).sort(),
    ).toEqual([
      expect.stringMatching(/probe-token-copy-[0-9a-f]{8}$/),
      expect.stringMatching(/probe-token-secret-[0-9a-f]{8}$/),
    ]);

    const result = await probe(
      (probe) => works(probe) && probe.sha256 !== sha256,
    );
    expect(result).toMatchObject({
      status: "active",
      accountRead: true,
      codes: [],
    });
    expect(result.sha256).not.toBe(sha256);
    sha256 = result.sha256;
  });

  it("leaves the rolled value alone on a deploy with the same config", async () => {
    await project.notation("deploy");

    expect((await theToken()).id).toBe(tokenId);
    const result = await probe(works);
    expect(result).toMatchObject({ status: "active", sha256 });
  });

  it("deletes the token and its secrets on destroy", async () => {
    await project.notation("destroy");

    expect(await tokensWithPrefix(name)).toEqual([]);
    expect(await secretsWithPrefix(name)).toEqual([]);
    expect(await project.workerNames()).toEqual([]);
  });
});
