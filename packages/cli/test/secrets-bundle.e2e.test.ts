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

it("keeps a secret's source out of the bundle of a Worker that binds it", async () => {
  write("infra/main.ts", `export {};`);
  write(
    "infra/secrets.ts",
    `
    import { secret } from "@notation/cloudflare/secrets-store";
    import { dotenv, env } from "@notation/std/sources";

    export const stripeKey = secret({ id: "stripe-key", source: env, key: "STRIPE_KEY" });
    export const webhook = secret({ id: "webhook", source: dotenv(".env"), key: "WEBHOOK" });
    export const admin = secret({ id: "admin" });
    `,
  );
  write(
    "runtime/api.ts",
    `
    import { $worker, secretsStore, type WorkerHandler } from "@notation/cloudflare/workers";
    import { admin, stripeKey, webhook } from "../infra/secrets";

    export const worker = $worker({
      id: "api",
      compatibilityDate: "2026-10-12",
      bindings: () => ({
        STRIPE_KEY: secretsStore.bind(stripeKey),
        WEBHOOK: secretsStore.bind(webhook),
        ADMIN: secretsStore.bind(admin),
      }),
    });

    export default {
      async fetch(request, env) {
        return new Response(String(Boolean(await env.STRIPE_KEY.get())));
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
  expect(bundle).not.toMatch(/@notation\/(core|std)|process\.env|SourceValue/);
}, 60_000);
