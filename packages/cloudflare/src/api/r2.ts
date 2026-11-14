import * as v from "valibot";
import { CloudflareApiError, cloudflare } from "./client";

const NO_SUCH_BUCKET = 10006;

export const jurisdictionSchema = v.picklist([
  "default",
  "eu",
  "us",
  "fedramp",
  "fedramp-high",
]);

export type Jurisdiction = v.InferOutput<typeof jurisdictionSchema>;

export const locationHintSchema = v.picklist([
  "apac",
  "eeur",
  "enam",
  "weur",
  "wnam",
  "oc",
]);

export type LocationHint = v.InferOutput<typeof locationHintSchema>;

export const storageClassSchema = v.picklist(["Standard", "InfrequentAccess"]);

export type StorageClass = v.InferOutput<typeof storageClassSchema>;

export type Bucket = {
  storage_class?: StorageClass;
};

export const isNoSuchBucket = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(NO_SUCH_BUCKET);

// The API docs list no error code for a bucket that still has objects. It is
// matched by its status and message.
export const isBucketNotEmpty = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.status === 409 &&
  error.hasMessage(/is not empty/);

const bucketsPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/r2/buckets`;

const bucketPath = (account: string, name: string) =>
  `${bucketsPath(account)}/${encodeURIComponent(name)}`;

const r2 = <T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  jurisdiction: Jurisdiction,
  options: { body?: object; headers?: Record<string, string> } = {},
) =>
  cloudflare<T>(method, path, options.body, {
    ...options.headers,
    "cf-r2-jurisdiction": jurisdiction,
  });

/** Returns `undefined` if the bucket doesn't exist. */
export async function getBucket(
  account: string,
  name: string,
  jurisdiction: Jurisdiction,
): Promise<Bucket | undefined> {
  try {
    return await r2<Bucket>("GET", bucketPath(account, name), jurisdiction);
  } catch (error) {
    if (isNoSuchBucket(error)) return undefined;
    throw error;
  }
}

export async function createBucket(
  account: string,
  name: string,
  jurisdiction: Jurisdiction,
  options: { locationHint?: LocationHint; storageClass: StorageClass },
): Promise<void> {
  await r2("POST", bucketsPath(account), jurisdiction, {
    body: {
      name,
      locationHint: options.locationHint,
      storageClass: options.storageClass,
    },
  });
}

/**
 * Sets the storage class of new objects. Objects that the bucket has keep
 * their storage class.
 */
export async function setBucketStorageClass(
  account: string,
  name: string,
  jurisdiction: Jurisdiction,
  storageClass: StorageClass,
): Promise<void> {
  await r2("PATCH", bucketPath(account, name), jurisdiction, {
    headers: { "cf-r2-storage-class": storageClass },
  });
}

/** Cloudflare deletes only an empty bucket. */
export async function deleteBucket(
  account: string,
  name: string,
  jurisdiction: Jurisdiction,
): Promise<void> {
  await r2("DELETE", bucketPath(account, name), jurisdiction);
}
