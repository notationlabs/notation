import { expect, it } from "vitest";
import {
  deleteKVValues,
  getKVValue,
  putKVValue,
  putKVValues,
} from "src/api/kv";
import {
  accountId,
  describeE2e,
  kvNamespacesWithPrefix,
  runPrefix,
  useProject,
  api,
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
    expect(await getKVValue(accountId, namespaceId, "routes", "json")).toEqual({
      a: 1,
    });
  });

  it("updates the value in place", async () => {
    project.write("infra/main.ts", infraModule(title, "routes", '{"a":2}'));
    await project.notation("deploy");

    expect(await getKVValue(accountId, namespaceId, "routes")).toBe('{"a":2}');
  });

  it("deletes the old key and writes the new one when the key changes", async () => {
    project.write("infra/main.ts", infraModule(title, "routes-v2", '{"a":2}'));
    await project.notation("deploy");

    expect(await getKVValue(accountId, namespaceId, "routes-v2")).toBe(
      '{"a":2}',
    );
    await expect
      .poll(() => getKVValue(accountId, namespaceId, "routes"), consistency)
      .toBeUndefined();
  });

  it("deletes the key and the namespace on destroy", async () => {
    await project.notation("destroy");

    expect(await kvNamespacesWithPrefix(runPrefix)).toEqual([]);
  });

  it("puts, gets and deletes values through the exported calls", async () => {
    const created = await api<{ id: string }>(
      "POST",
      "/storage/kv/namespaces",
      {
        title: `${runPrefix}-calls`,
      },
    );
    expect(created.success).toBe(true);
    const id = created.result.id;

    await putKVValue(accountId, id, "one", { n: 1 }, { metadata: { v: 1 } });
    await putKVValue(accountId, id, "lines", "a\nb\r\nc");
    expect(await getKVValue(accountId, id, "lines")).toBe("a\nb\r\nc");
    await putKVValues(accountId, id, [
      { key: "two", value: "2\n" },
      { key: "three", value: [3] },
    ]);
    expect(await getKVValue(accountId, id, "one", "json")).toEqual({ n: 1 });
    expect(await getKVValue(accountId, id, "two")).toBe("2\n");
    expect(await getKVValue(accountId, id, "three", "json")).toEqual([3]);

    await deleteKVValues(accountId, id, ["one", "lines", "two", "three"]);
    await expect
      .poll(() => getKVValue(accountId, id, "one"), consistency)
      .toBeUndefined();
  });
});
