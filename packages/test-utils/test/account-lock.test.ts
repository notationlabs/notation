import { describe, expect, it } from "vitest";
import {
  type AccountLockOptions,
  type LockRecord,
  type LockStore,
  defaultHolder,
  takeAccountLock,
  withAccountLock,
} from "../src/account-lock";

const MINUTE = 60_000;

// An in-memory store whose create fails when the name exists, and a clock
// that `sleep` moves forward.
function setup() {
  const locks = new Map<string, LockRecord>();
  let nextId = 1;
  let time = Date.parse("2026-11-14T12:00:00Z");
  const log: string[] = [];
  const store: LockStore = {
    async create(name, holder) {
      if (locks.has(name)) return undefined;
      const id = `id-${nextId++}`;
      locks.set(name, { id, holder, created: new Date(time) });
      log.push(`create ${id}`);
      return id;
    },
    async read(name) {
      return locks.get(name);
    },
    async delete(id) {
      for (const [name, lock] of locks) {
        if (lock.id === id) locks.delete(name);
      }
      log.push(`delete ${id}`);
    },
  };
  const options: AccountLockOptions = {
    store,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    retryMs: MINUTE,
  };
  const hold = (holder: string, created: number) => {
    const id = `id-${nextId++}`;
    locks.set("ne2e-lock-registry", { id, holder, created: new Date(created) });
    return id;
  };
  return {
    locks,
    log,
    options,
    hold,
    now: () => time,
    advance: (ms: number) => (time += ms),
  };
}

describe("takeAccountLock", () => {
  it("takes a free lock, and records the holder and the time", async () => {
    const { locks, options, now } = setup();
    const lock = await takeAccountLock("registry", options);
    expect(lock.name).toBe("ne2e-lock-registry");
    expect(locks.get("ne2e-lock-registry")).toMatchObject({
      holder: defaultHolder,
      created: new Date(now()),
    });
  });

  it("waits until the holder releases the lock", async () => {
    const { locks, options, now } = setup();
    const start = now();
    const held = await takeAccountLock("registry", options);
    let released = false;
    const waiting = takeAccountLock("registry", {
      ...options,
      sleep: async (ms) => {
        await options.sleep!(ms);
        // The holder releases the lock after three minutes.
        if (now() - start >= 3 * MINUTE && !released) {
          released = true;
          await held.release();
        }
      },
    });
    await waiting;
    expect(now() - start).toBe(3 * MINUTE);
    expect(locks.get("ne2e-lock-registry")?.id).toBe("id-2");
  });

  it("times out with the holder and the time", async () => {
    const { options, hold, now } = setup();
    hold("ne2e-abc123", now() - MINUTE);
    await expect(
      takeAccountLock("registry", { ...options, waitMs: 5 * MINUTE }),
    ).rejects.toThrow(
      "Timed out after 300s waiting for the lock ne2e-lock-registry. " +
        "ne2e-abc123 took it at 2026-11-14T11:59:00.000Z.",
    );
  });

  it("deletes a lock older than the maximum age, and takes it", async () => {
    const { locks, log, options, hold, now } = setup();
    const stale = hold("ne2e-abc123", now() - 61 * MINUTE);
    await takeAccountLock("registry", options);
    expect(log).toEqual([`delete ${stale}`, "create id-2"]);
    expect(locks.get("ne2e-lock-registry")?.holder).toBe(defaultHolder);
  });

  it("takes over a lock that a killed run just took, with the default times", async () => {
    const { locks, options, hold, now } = setup();
    const start = now();
    hold("ne2e-abc123", start);
    await takeAccountLock("registry", { ...options, retryMs: 10_000 });
    expect(now() - start).toBeGreaterThan(60 * MINUTE);
    expect(locks.get("ne2e-lock-registry")?.holder).toBe(defaultHolder);
  });

  it("waits for a lock younger than a maximum age that is set", async () => {
    const { options, hold, now } = setup();
    hold("ne2e-abc123", now() - 2 * MINUTE);
    await expect(
      takeAccountLock("registry", {
        ...options,
        maxAgeMs: 10 * MINUTE,
        waitMs: 5 * MINUTE,
      }),
    ).rejects.toThrow("Timed out");
  });

  it("gives a stale lock to only one of two runs that steal it at once", async () => {
    const { locks, log, options, hold, now } = setup();
    const stale = hold("ne2e-abc123", now() - 61 * MINUTE);
    const [first, second] = await Promise.allSettled([
      takeAccountLock("registry", { ...options, waitMs: 0 }),
      takeAccountLock("registry", { ...options, waitMs: 0 }),
    ]);
    // Both delete the stale lock by its ID, so the second delete doesn't
    // remove the lock that the first run then created.
    expect(log.filter((entry) => entry.startsWith("create"))).toHaveLength(1);
    expect(log).toContain(`delete ${stale}`);
    expect(locks.get("ne2e-lock-registry")?.holder).toBe(defaultHolder);
    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });
});

describe("release", () => {
  it("deletes the lock while this run holds it", async () => {
    const { locks, options } = setup();
    const lock = await takeAccountLock("registry", options);
    await lock.release();
    expect(locks.size).toBe(0);
  });

  it("leaves a lock that another run took over", async () => {
    const { locks, options, hold, now } = setup();
    const lock = await takeAccountLock("registry", options);
    const other = hold("ne2e-abc123", now());
    await lock.release();
    expect(locks.get("ne2e-lock-registry")?.id).toBe(other);
  });
});

describe("withAccountLock", () => {
  it("releases the lock after the work, and when the work throws", async () => {
    const { locks, options } = setup();
    let heldDuringWork = false;
    await withAccountLock(
      "registry",
      async () => {
        heldDuringWork = locks.has("ne2e-lock-registry");
      },
      options,
    );
    expect(heldDuringWork).toBe(true);
    expect(locks.size).toBe(0);

    await expect(
      withAccountLock(
        "registry",
        async () => {
          throw new Error("deploy failed");
        },
        options,
      ),
    ).rejects.toThrow("deploy failed");
    expect(locks.size).toBe(0);
  });
});
