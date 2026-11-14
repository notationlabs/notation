import { expect, it } from "vitest";
import { getKVValue, putKVValue } from "src/api/kv";
import {
  accountId,
  describeE2e,
  kvNamespacesWithPrefix,
  runPrefix,
  useProject,
} from "../e2e";

const infraModule = (title: string, key: string, value: string) => `
  import { kv } from "@notation/cloudflare/resources";

  const namespace = new kv.KVNamespace("config", { config: { Title: "${title}" } });

  new kv.KVValue("config:routes", {
    config: { Key: "${key}", Value: ${JSON.stringify(value)} },
    dependencies: { namespace },
  });
`;

// KV is eventually consistent, so a read can show a deleted key for about
// 60 seconds.
const consistency = { timeout: 90_000, interval: 3_000 };

describeE2e("KVValue", () => {
  const project = useProject();
  const title = `${runPrefix}-config`;
  let namespaceId: string;

  it("writes the value on deploy", async () => {
    project.write(
      "infra/main.ts",
      infraModule(title, "routes", '{\n  "a": 1\n}'),
    );
    await project.notation("deploy");

    const namespaces = await kvNamespacesWithPrefix(runPrefix);
    expect(namespaces.map((namespace) => namespace.title)).toEqual([title]);
    namespaceId = namespaces[0]!.id;
    expect(await getKVValue(accountId, namespaceId, "routes")).toBe(
      '{\n  "a": 1\n}',
    );
  });

  it("updates the value in place", async () => {
    project.write("infra/main.ts", infraModule(title, "routes", '{"a":2}'));
    await project.notation("deploy");

    expect(await getKVValue(accountId, namespaceId, "routes")).toBe('{"a":2}');
  });

  it("writes the new key and deletes the old one when the key changes", async () => {
    project.write("infra/main.ts", infraModule(title, "routes-v2", '{"a":2}'));
    await project.notation("deploy");

    expect(await getKVValue(accountId, namespaceId, "routes-v2")).toBe(
      '{"a":2}',
    );
    await expect
      .poll(() => getKVValue(accountId, namespaceId, "routes"), consistency)
      .toBeUndefined();
  });

  it("refuses to change to a key that already exists, and leaves its value", async () => {
    await putKVValue(accountId, namespaceId, "taken", "theirs");
    project.write("infra/main.ts", infraModule(title, "taken", '{"a":2}'));

    await expect(project.notation("deploy")).rejects.toThrow(
      `already has the key "taken"`,
    );
    expect(await getKVValue(accountId, namespaceId, "taken")).toBe("theirs");
  });

  it("deletes the key and the namespace on destroy", async () => {
    await project.notation("destroy");

    expect(await kvNamespacesWithPrefix(runPrefix)).toEqual([]);
  });
});
