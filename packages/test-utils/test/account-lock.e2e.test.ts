import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  hasCloudflareCredentials,
  lockName,
  secretsStoreLocks,
  withAccountLock,
} from "../src/account-lock";

describe.skipIf(!hasCloudflareCredentials())("withAccountLock", () => {
  // A name of this run's own, so that this test never waits for real runs.
  const name = `selftest-${randomBytes(3).toString("hex")}`;

  it("runs the work of two holders of the same lock one after the other", async () => {
    const store = secretsStoreLocks();
    const events: string[] = [];
    const holders: (string | undefined)[] = [];
    const work = (label: string) => async () => {
      events.push(`start ${label}`);
      holders.push((await store.read(lockName(name)))?.holder);
      await sleep(2_000);
      events.push(`end ${label}`);
    };
    const options = { retryMs: 1_000, waitMs: 120_000 };
    try {
      await Promise.all([
        withAccountLock(name, work("a"), { ...options, holder: "a" }),
        withAccountLock(name, work("b"), { ...options, holder: "b" }),
      ]);
    } finally {
      const left = await store.read(lockName(name));
      if (left) await store.delete(left.id);
    }
    const [first, second] = events[0] === "start a" ? ["a", "b"] : ["b", "a"];
    expect(events).toEqual([
      `start ${first}`,
      `end ${first}`,
      `start ${second}`,
      `end ${second}`,
    ]);
    expect(holders).toEqual([first, second]);
    expect(await store.read(lockName(name))).toBeUndefined();
  });
});
