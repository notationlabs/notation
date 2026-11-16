import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { compileInfra, compileRuntimeModules } from "../src/compile";

// Inside this package, so that the project's imports of @notation/cloudflare
// and @notation/std resolve to the built packages.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-secrets-e2e-")));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

it("keeps the resources of a Worker's secrets out of its bundle", async () => {
  write("infra/main.ts", `export {};`);
  write(
    "infra/secrets.ts",
    `
    import * as cloudflare from "@notation/cloudflare/resources";

    const store = new cloudflare.secretsStore.SecretsStore("store");
    const token = new cloudflare.tokens.AccountToken("deploy-token", {
      config: {
        Policies: [
          {
            effect: "allow",
            permissionGroups: ["Workers Scripts Write"],
            resources: { "com.cloudflare.api.account.acc": "*" },
          },
        ],
      },
    });
    export const tokenValue = token.credentials.Value;
    export const tokenSecret = new cloudflare.secretsStore.SecretsStoreSecret(
      "deploy-token-secret",
      { config: { Value: token.credentials.Value }, dependencies: { store } },
    );
    `,
  );
  write(
    "runtime/api.ts",
    `
    import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
    import { tokenSecret, tokenValue } from "../infra/secrets";

    export const worker = $worker({
      id: "api",
      compatibilityDate: "2026-10-12",
      bindings: () => ({
        DEPLOY_TOKEN: tokenSecret,
        TOKEN_TEXT: tokenValue,
      }),
    });

    export default {
      async fetch(request, env) {
        return new Response(String(Boolean(await env.DEPLOY_TOKEN.get()) && env.TOKEN_TEXT));
      },
    } satisfies WorkerHandler<typeof worker>;
    `,
  );

  await compileRuntimeModules(
    (await compileInfra(path.join(root, "infra/main.ts"))).modules,
  );

  const bundle = readFileSync(
    path.join(root, "dist/runtime/api/index.mjs"),
    "utf8",
  );
  expect(bundle).not.toMatch(
    /@notation\/(core|std|resource)|process\.env|AccountToken|SecretsStoreSecret/,
  );
}, 60_000);
