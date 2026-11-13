import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NodeDurableRuntime,
  Redacted,
  clearRecordedSecrets,
  clearSecretTargets,
  runDurableWorkflow,
  runWithExecutionContext,
} from "@notation/core";
import { setConfigFile } from "@notation/core/paths";
import * as durable from "@notation/reconciler/durable";
import { createPlan } from "@notation/reconciler";
import { resource, type BaseResource } from "@notation/resource";
import * as stdResources from "src/resources";
import { SourceValue } from "src/resources/sources";
import {
  dotenv,
  env,
  getValue,
  registerSecretTarget,
  type Source,
} from "src/sources";

let directory: string;
let runtime: NodeDurableRuntime;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-std-source-value-"));
  await writeFile(
    path.join(directory, "notation.config.ts"),
    "export default {};\n",
  );
  setConfigFile(path.join(directory, "notation.config.ts"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "std", stage: "dev" },
    databasePath: path.join(directory, "workflows.db"),
  });
});

afterEach(async () => {
  setConfigFile(undefined);
  clearRecordedSecrets();
  clearSecretTargets();
  runtime.close();
  await rm(directory, { recursive: true, force: true });
});

function defineMockSecret(
  written: Array<{ id: string; value: string; version: string }>,
) {
  return resource<{
    Key: { Name: string };
    CreateParams: {
      Name: string;
      ValueFrom: { Source: string; Key: string; Version: string };
    };
    UpdateParams: {
      Name: string;
      ValueFrom: { Source: string; Key: string; Version: string };
    };
    ReadResult: {};
  }>({
    type: "test/secrets/MockSecret",
    provider: "test",
  })
    .defineSchema({
      Name: {
        propertyType: "param",
        presence: "required",
        value: v.string(),
        primaryKey: true,
        immutable: true,
      },
      ValueFrom: {
        propertyType: "param",
        presence: "required",
        value: v.object({
          Source: v.string(),
          Key: v.string(),
          Version: v.string(),
        }),
      },
    })
    .defineOperations({
      create: async (params) => {
        const val = await getValue(params.Name);
        written.push({
          id: params.Name,
          value: val.unwrap(),
          version: params.ValueFrom.Version,
        });
        return undefined as any;
      },
      update: async (_key, _patch, params) => {
        const val = await getValue(params.Name);
        written.push({
          id: params.Name,
          value: val.unwrap(),
          version: params.ValueFrom.Version,
        });
      },
      delete: async () => {},
    });
}

describe("SourceValue resource", () => {
  it("exports SourceValue from @notation/std/resources with expected provider and type", () => {
    expect(stdResources.sources.SourceValue).toBe(SourceValue);
    expect(SourceValue.type).toBe("std/sources/SourceValue");
    expect(SourceValue.provider).toBe("@notation/std/resources");
  });

  it("fails on first plan when key is missing from source", async () => {
    const emptySource: Source = {
      name: "infisical",
      async has() {
        return false;
      },
      async get() {
        throw new Error("unreachable");
      },
    };
    const sv = new SourceValue("value:stripe-key", {
      config: { Source: emptySource.name, Key: "STRIPE_KEY" },
      source: emptySource,
    });

    await expect(
      runWithExecutionContext({ stage: "dev", executionId: "plan-1" }, () =>
        createPlan({
          resources: [sv],
          state: runtime.state,
        }),
      ),
    ).rejects.toThrow(
      "STRIPE_KEY isn't in the infisical source of stripe-key.",
    );
  });

  it("uses source.version when available and triggers dependent updates only on version change", async () => {
    let remoteVersion = "14";
    let sentinelValue = "SENTINEL_SECRET_VALUE_DO_NOT_LEAK_V14";
    const written: Array<{ id: string; value: string; version: string }> = [];
    const MockSecret = defineMockSecret(written);

    const vault: Source = {
      name: "infisical",
      async has(key) {
        return key === "STRIPE_KEY";
      },
      async version() {
        return remoteVersion;
      },
      async get() {
        return new Redacted(sentinelValue);
      },
    };

    const buildGraph = (): BaseResource[] => {
      const valueRes = new SourceValue("value:stripe-key", {
        config: { Source: vault.name, Key: "STRIPE_KEY" },
        source: vault,
      });
      const secretRes = new MockSecret("secret:stripe-key", {
        config: {
          Name: "stripe-key",
          ValueFrom: {
            Source: "infisical",
            Key: "STRIPE_KEY",
            Version: valueRes.outputRef("Version"),
          },
        },
        dependencies: { value: valueRes },
      });
      registerSecretTarget({
        id: "stripe-key",
        resource: secretRes,
        source: vault,
        key: "STRIPE_KEY",
      });
      return [valueRes, secretRes];
    };

    const deploy = (executionId: string) =>
      runWithExecutionContext({ stage: "dev", executionId }, () =>
        runDurableWorkflow(
          { workflowId: "deploy", runtime, executionId },
          (step, execId) =>
            durable.deploy(step, {
              executionId: execId,
              resources: buildGraph(),
              state: runtime.state,
            }),
        ),
      );

    // 1. First deploy creates both and records Version "14", never the sentinel
    await deploy("exec-1");
    expect(written).toEqual([
      {
        id: "stripe-key",
        value: "SENTINEL_SECRET_VALUE_DO_NOT_LEAK_V14",
        version: "14",
      },
    ]);
    const state1 = await runtime.state.values();
    expect(JSON.stringify(state1)).not.toContain(
      "SENTINEL_SECRET_VALUE_DO_NOT_LEAK",
    );
    expect(await runtime.state.get("value:stripe-key")).toMatchObject({
      params: { Source: "infisical", Key: "STRIPE_KEY" },
      output: { Version: "14" },
    });

    // 2. Plan with same version -> both noop
    const planSame = await runWithExecutionContext(
      { stage: "dev", executionId: "plan-same" },
      () => createPlan({ resources: buildGraph(), state: runtime.state }),
    );
    expect(planSame.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["value:stripe-key", "noop"],
      ["secret:stripe-key", "noop"],
    ]);
    expect(JSON.stringify(planSame)).not.toContain(
      "SENTINEL_SECRET_VALUE_DO_NOT_LEAK",
    );

    // 3. Deploy with same version -> no rewrite
    await deploy("exec-2");
    expect(written).toHaveLength(1);

    // 4. Bump remote version -> plan shows value noop and secret update with Version "15"
    remoteVersion = "15";
    sentinelValue = "SENTINEL_SECRET_VALUE_DO_NOT_LEAK_V15";
    const planBumped = await runWithExecutionContext(
      { stage: "dev", executionId: "plan-bumped" },
      () => createPlan({ resources: buildGraph(), state: runtime.state }),
    );
    expect(planBumped.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["value:stripe-key", "noop"],
      ["secret:stripe-key", "update"],
    ]);
    expect(planBumped.nodes[1]?.params).toMatchObject({
      ValueFrom: { Source: "infisical", Key: "STRIPE_KEY", Version: "15" },
    });

    // 5. Deploy writes new sentinel and updates state Version to "15"
    await deploy("exec-3");
    expect(written).toEqual([
      {
        id: "stripe-key",
        value: "SENTINEL_SECRET_VALUE_DO_NOT_LEAK_V14",
        version: "14",
      },
      {
        id: "stripe-key",
        value: "SENTINEL_SECRET_VALUE_DO_NOT_LEAK_V15",
        version: "15",
      },
    ]);
    expect(await runtime.state.get("value:stripe-key")).toMatchObject({
      output: { Version: "15" },
    });
    const state2 = await runtime.state.values();
    expect(JSON.stringify(state2)).not.toContain(
      "SENTINEL_SECRET_VALUE_DO_NOT_LEAK",
    );
  });

  it("uses executionId as Version for unversioned sources (env/dotenv) and updates on every deploy", async () => {
    await writeFile(
      path.join(directory, ".env.local"),
      "WEBHOOK_SECRET=whsec_sentinel_dotenv\n",
    );
    const localDotenv = dotenv(".env.local");
    const written: Array<{ id: string; value: string; version: string }> = [];
    const MockSecret = defineMockSecret(written);

    const buildGraph = (): BaseResource[] => {
      const valueRes = new SourceValue("value:webhook", {
        config: { Source: localDotenv.name, Key: "WEBHOOK_SECRET" },
        source: localDotenv,
      });
      const secretRes = new MockSecret("secret:webhook", {
        config: {
          Name: "webhook",
          ValueFrom: {
            Source: "dotenv",
            Key: "WEBHOOK_SECRET",
            Version: valueRes.outputRef("Version"),
          },
        },
        dependencies: { value: valueRes },
      });
      registerSecretTarget({
        id: "webhook",
        resource: secretRes,
        source: localDotenv,
        key: "WEBHOOK_SECRET",
      });
      return [valueRes, secretRes];
    };

    const deploy = (executionId: string) =>
      runWithExecutionContext({ stage: "dev", executionId }, () =>
        runDurableWorkflow(
          { workflowId: "deploy", runtime, executionId },
          (step, execId) =>
            durable.deploy(step, {
              executionId: execId,
              resources: buildGraph(),
              state: runtime.state,
            }),
        ),
      );

    await deploy("run-1");
    await deploy("run-2");

    expect(written).toEqual([
      { id: "webhook", value: "whsec_sentinel_dotenv", version: "run-1" },
      { id: "webhook", value: "whsec_sentinel_dotenv", version: "run-2" },
    ]);
    expect(await runtime.state.get("value:webhook")).toMatchObject({
      output: { Version: "run-2" },
    });
    expect(JSON.stringify(await runtime.state.values())).not.toContain(
      "whsec_sentinel_dotenv",
    );
  });

  it("updates SourceValue in-place when source changes and deletes cleanly even if source key is gone", async () => {
    const key = "NOTATION_TEST_SOURCE_SWITCH";
    const prev = process.env[key];
    process.env[key] = "sentinel-from-env";
    try {
      const written: Array<{ id: string; value: string; version: string }> = [];
      const MockSecret = defineMockSecret(written);

      const deployWith = (source: Source, executionId: string) => {
        const valueRes = new SourceValue("value:api-key", {
          config: { Source: source.name, Key: key },
          source,
        });
        const secretRes = new MockSecret("secret:api-key", {
          config: {
            Name: "api-key",
            ValueFrom: {
              Source: source.name,
              Key: key,
              Version: valueRes.outputRef("Version"),
            },
          },
          dependencies: { value: valueRes },
        });
        registerSecretTarget({
          id: "api-key",
          resource: secretRes,
          source,
          key,
        });
        return runWithExecutionContext({ stage: "dev", executionId }, () =>
          runDurableWorkflow(
            { workflowId: "deploy", runtime, executionId },
            (step, execId) =>
              durable.deploy(step, {
                executionId: execId,
                resources: [valueRes, secretRes],
                state: runtime.state,
              }),
          ),
        );
      };

      await deployWith(env, "e1");
      await writeFile(
        path.join(directory, ".env"),
        `${key}=sentinel-from-dotenv\n`,
      );
      const dotenvSource = dotenv(".env");

      const planSwitch = await runWithExecutionContext(
        { stage: "dev", executionId: "plan-switch" },
        () =>
          createPlan({
            resources: [
              new SourceValue("value:api-key", {
                config: { Source: dotenvSource.name, Key: key },
                source: dotenvSource,
              }),
            ],
            state: runtime.state,
          }),
      );
      expect(planSwitch.nodes[0]?.decision).toBe("update");

      await deployWith(dotenvSource, "e2");
      expect(written).toEqual([
        { id: "api-key", value: "sentinel-from-env", version: "e1" },
        { id: "api-key", value: "sentinel-from-dotenv", version: "e2" },
      ]);

      // Remove env & dotenv file, then destroy: SourceValue.delete is a no-op
      delete process.env[key];
      await rm(path.join(directory, ".env"));
      await runWithExecutionContext(
        { stage: "dev", executionId: "destroy-1" },
        () =>
          runDurableWorkflow(
            { workflowId: "destroy", runtime, executionId: "destroy-1" },
            (step, execId) => {
              const valueRes = new SourceValue("value:api-key", {
                config: { Source: "dotenv", Key: key },
              });
              const secretRes = new MockSecret("secret:api-key", {
                config: {
                  Name: "api-key",
                  ValueFrom: {
                    Source: "dotenv",
                    Key: key,
                    Version: valueRes.outputRef("Version"),
                  },
                },
                dependencies: { value: valueRes },
              });
              return durable.destroy(step, {
                executionId: execId,
                resources: [valueRes, secretRes],
                state: runtime.state,
              });
            },
          ),
      );
      expect(await runtime.state.get("value:api-key")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("detects source version changes even when driftDetection is false (watch mode)", async () => {
    let remoteVersion = "v1";
    let sentinelValue = "WATCH_SENTINEL_V1";
    const written: Array<{ id: string; value: string; version: string }> = [];
    const MockSecret = defineMockSecret(written);

    const vault: Source = {
      name: "infisical",
      async has(key) {
        return key === "STRIPE_KEY";
      },
      async version() {
        return remoteVersion;
      },
      async get() {
        return new Redacted(sentinelValue);
      },
    };

    const buildGraph = (): BaseResource[] => {
      const valueRes = new SourceValue("value:stripe-key", {
        config: { Source: vault.name, Key: "STRIPE_KEY" },
        source: vault,
      });
      const secretRes = new MockSecret("secret:stripe-key", {
        config: {
          Name: "stripe-key",
          ValueFrom: {
            Source: "infisical",
            Key: "STRIPE_KEY",
            Version: valueRes.outputRef("Version"),
          },
        },
        dependencies: { value: valueRes },
      });
      registerSecretTarget({
        id: "stripe-key",
        resource: secretRes,
        source: vault,
        key: "STRIPE_KEY",
      });
      return [valueRes, secretRes];
    };

    const deployNoDrift = (executionId: string) =>
      runWithExecutionContext({ stage: "dev", executionId }, () =>
        runDurableWorkflow(
          { workflowId: "deploy", runtime, executionId },
          (step, execId) =>
            durable.deploy(step, {
              executionId: execId,
              resources: buildGraph(),
              state: runtime.state,
              driftDetection: false,
            }),
        ),
      );

    await deployNoDrift("w1");
    expect(written).toEqual([
      { id: "stripe-key", value: "WATCH_SENTINEL_V1", version: "v1" },
    ]);

    remoteVersion = "v2";
    sentinelValue = "WATCH_SENTINEL_V2";

    const planNoDrift = await runWithExecutionContext(
      { stage: "dev", executionId: "plan-no-drift" },
      () =>
        createPlan({
          resources: buildGraph(),
          state: runtime.state,
          driftDetection: false,
        }),
    );
    expect(planNoDrift.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["value:stripe-key", "noop"],
      ["secret:stripe-key", "update"],
    ]);

    await deployNoDrift("w2");
    expect(written).toEqual([
      { id: "stripe-key", value: "WATCH_SENTINEL_V1", version: "v1" },
      { id: "stripe-key", value: "WATCH_SENTINEL_V2", version: "v2" },
    ]);
  });
});
