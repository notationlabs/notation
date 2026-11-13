import { afterEach, expect, it, vi } from "vitest";
import { declareSecret, runWithSecretContext } from "@notation/core";
import { collectResourceGraph, type BaseResource } from "@notation/resource";
import { sources } from "@notation/std/resources";
import { getValue } from "@notation/std/sources";
import { infisical } from "src/sources";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("gives a SourceValue its version, and getValue its value, from one fetch", async () => {
  vi.stubEnv("INFISICAL_TOKEN", "st.token");
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      secrets: [
        {
          id: "sec-1",
          version: 14,
          secretKey: "STRIPE_KEY",
          secretValue: "sk_live_sentinel",
          secretValueHidden: false,
        },
      ],
    }),
  );
  const source = infisical({
    projectId: "proj",
    environment: (stage) => stage,
    path: "/orders",
  });

  const result = await runWithSecretContext(
    { stage: "dev", runId: "exec-1" },
    async () => {
      await collectResourceGraph(() => {
        declareSecret({
          id: "stripe-key",
          resource: {} as BaseResource,
          source,
          key: "STRIPE_KEY",
        });
      });
      const value = new sources.SourceValue("value:stripe-key", {
        config: { Source: source.name, Key: "STRIPE_KEY" },
        source,
        secret: "stripe-key",
      });
      return {
        params: await value.getParams(),
        value: (await getValue("stripe-key")).unwrap(),
      };
    },
  );

  expect(result).toEqual({
    params: { Source: "infisical", Key: "STRIPE_KEY", Version: "sec-1:14" },
    value: "sk_live_sentinel",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
