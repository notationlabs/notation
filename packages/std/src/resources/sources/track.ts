import crypto from "node:crypto";
import { promisify } from "node:util";
import * as v from "valibot";

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export type Track = "scrypt" | "hmac";

export const trackValidator = v.picklist(["scrypt", "hmac"]);

export const TRACK_KEY_VARIABLE = "NOTATION_TRACK_KEY";

// N = 2^17 and r = 8 need 128 MiB for each hash, more than Node's default
// `maxmem` of 32 MiB allows.
const SCRYPT_OPTIONS: crypto.ScryptOptions = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};

export type TrackScope = { app: string; stage: string; id: string };

const cache = new Map<string, Promise<string>>();

/**
 * Throws when `track` is `"hmac"` and `NOTATION_TRACK_KEY` is not set.
 */
export function assertTrackKey(track: Track): void {
  if (track === "hmac" && !process.env[TRACK_KEY_VARIABLE]) {
    throw new Error(
      `track: "hmac" needs a key in ${TRACK_KEY_VARIABLE}. Make one with \`openssl rand -hex 32\`, and set the same key on every machine that plans or deploys.`,
    );
  }
}

/**
 * Returns the revision of a tracked value: a hash of it, salted with the
 * app, the stage and the source's ID, so that two sources with the same
 * value have different revisions. The hash is cached for the process.
 */
export function trackRevision(
  track: Track,
  scope: TrackScope,
  value: string,
): Promise<string> {
  assertTrackKey(track);
  const key = track === "hmac" ? process.env[TRACK_KEY_VARIABLE]! : "";
  const salt = JSON.stringify([scope.app, scope.stage, scope.id]);
  // The cache key holds a digest, and not the value or the track key.
  const cacheKey = crypto
    .createHash("sha256")
    .update(JSON.stringify([track, key, salt, value]))
    .digest("hex");
  let revision = cache.get(cacheKey);
  if (!revision) {
    revision = hash(track, key, salt, value);
    cache.set(cacheKey, revision);
    revision.catch(() => cache.delete(cacheKey));
  }
  return revision;
}

async function hash(
  track: Track,
  key: string,
  salt: string,
  value: string,
): Promise<string> {
  if (track === "hmac") {
    const digest = crypto
      .createHmac("sha256", key)
      .update(salt)
      // JSON escapes every control character, so the salt holds no NUL.
      .update("\0")
      .update(value)
      .digest("hex");
    return `hmac:${digest}`;
  }
  const digest = await scrypt(value, salt, 32, SCRYPT_OPTIONS);
  return `scrypt:${digest.toString("hex")}`;
}
