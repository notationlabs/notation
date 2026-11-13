import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountSubdomain,
  api,
  deleteScriptsWithPrefix,
  hasCredentials,
  latestVersionId,
  poll,
  runPrefix,
  scriptsWithPrefix,
  uploadScript,
} from "./cloudflare";

const prefix = `${runPrefix}-limit-`;

// A name of `length` characters that starts with this run's prefix.
const nameOf = (length: number) =>
  `${prefix}${length}-`.padEnd(length - 1, "a") + "z";

let subdomain: string;

describe.skipIf(!hasCredentials)("the length of a Worker's name", () => {
  beforeAll(async () => {
    subdomain = await accountSubdomain();
  });

  afterAll(async () => {
    await deleteScriptsWithPrefix(prefix);
    expect(await scriptsWithPrefix(prefix)).toEqual([]);
  });

  it("serves a 54 character name on workers.dev and at a preview URL, with a label of 63 characters", async () => {
    const name = nameOf(54);
    expect((await uploadScript(name)).errors).toEqual([]);

    // Without `previews_enabled`, enabling workers.dev enables preview URLs
    // too.
    const enabled = await api("POST", `/workers/scripts/${name}/subdomain`, {
      enabled: true,
    });
    expect(enabled.result).toEqual({ enabled: true, previews_enabled: true });

    const version = await latestVersionId(name);
    const label = `${version.slice(0, 8)}-${name}`;
    expect(label).toHaveLength(63);
    const [main, preview] = await Promise.all([
      poll(`https://${name}.${subdomain}.workers.dev/`),
      poll(`https://${label}.${subdomain}.workers.dev/`),
    ]);
    expect(main).toMatchObject({ ok: true });
    expect(preview).toMatchObject({ ok: true });
  });

  it("uploads a 55 character name, but refuses to enable workers.dev with preview URLs", async () => {
    const name = nameOf(55);
    expect((await uploadScript(name)).errors).toEqual([]);

    const enabled = await api("POST", `/workers/scripts/${name}/subdomain`, {
      enabled: true,
    });
    expect(enabled.status).toBe(400);
    expect(enabled.errors).toEqual([
      expect.objectContaining({
        code: 100315,
        message: expect.stringMatching(/cannot be longer than 54 characters/),
      }),
    ]);
  });

  it("serves a 63 character name on workers.dev with preview URLs off", async () => {
    const name = nameOf(63);
    expect((await uploadScript(name)).errors).toEqual([]);

    const enabled = await api("POST", `/workers/scripts/${name}/subdomain`, {
      enabled: true,
      previews_enabled: false,
    });
    expect(enabled.result).toEqual({ enabled: true, previews_enabled: false });
    expect(
      await poll(`https://${name}.${subdomain}.workers.dev/`),
    ).toMatchObject({ ok: true });

    // What `WorkerSubdomain` sends. Without `previews_enabled`, Cloudflare
    // turns preview URLs on, even for a Worker that has them off.
    const again = await api("POST", `/workers/scripts/${name}/subdomain`, {
      enabled: true,
    });
    expect(again.errors).toEqual([expect.objectContaining({ code: 100315 })]);
  });

  it("uploads a 64 character name, but refuses to serve it on workers.dev", async () => {
    const name = nameOf(64);
    expect((await uploadScript(name)).errors).toEqual([]);

    const enabled = await api("POST", `/workers/scripts/${name}/subdomain`, {
      enabled: true,
      previews_enabled: false,
    });
    expect(enabled.status).toBe(400);
    expect(enabled.errors).toEqual([
      expect.objectContaining({
        code: 100132,
        message: expect.stringMatching(/63 characters or less/),
      }),
    ]);
  });
});
