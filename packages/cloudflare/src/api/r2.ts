import * as v from "valibot";
import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a bucket that doesn't exist. */
const NO_SUCH_BUCKET = 10006;

/** Cloudflare's error code for a bucket name that is taken in the account. */
const BUCKET_ALREADY_EXISTS = 10004;

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

export type BucketKey = {
  account: string;
  name: string;
  jurisdiction: Jurisdiction;
};

export type Bucket = {
  name?: string;
  jurisdiction?: Jurisdiction;
  location?: LocationHint;
  storage_class?: StorageClass | null;
};

export const isNoSuchBucket = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(NO_SUCH_BUCKET);

export const isBucketAlreadyExists = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(BUCKET_ALREADY_EXISTS);

// Cloudflare reports a bucket that still has objects with status 409 and no
// code of its own.
export const isBucketNotEmpty = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.status === 409 &&
  error.hasMessage(/is not empty/i);

const bucketsPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/r2/buckets`;

const bucketPath = (key: BucketKey) =>
  `${bucketsPath(key.account)}/${encodeURIComponent(key.name)}`;

// A request without the header uses the default jurisdiction. A bucket in
// another jurisdiction is only found with the header.
const jurisdictionHeader = (
  jurisdiction: Jurisdiction,
): Record<string, string> =>
  jurisdiction === "default" ? {} : { "cf-r2-jurisdiction": jurisdiction };

/** Returns `undefined` if the bucket doesn't exist. */
export async function getBucket(key: BucketKey): Promise<Bucket | undefined> {
  try {
    return await cloudflare<Bucket>(
      "GET",
      bucketPath(key),
      undefined,
      jurisdictionHeader(key.jurisdiction),
    );
  } catch (error) {
    if (isNoSuchBucket(error)) return undefined;
    throw error;
  }
}

/** Fails with code 10004 if the account has a bucket with the name. */
export async function createBucket(
  key: BucketKey,
  options: { locationHint?: LocationHint; storageClass: StorageClass },
): Promise<void> {
  await cloudflare(
    "POST",
    bucketsPath(key.account),
    {
      name: key.name,
      locationHint: options.locationHint,
      storageClass: options.storageClass,
    },
    jurisdictionHeader(key.jurisdiction),
  );
}

/**
 * Sets the storage class of new objects. Objects that the bucket has keep
 * their storage class.
 */
export async function setBucketStorageClass(
  key: BucketKey,
  storageClass: StorageClass,
): Promise<void> {
  await cloudflare("PATCH", bucketPath(key), undefined, {
    ...jurisdictionHeader(key.jurisdiction),
    "cf-r2-storage-class": storageClass,
  });
}

/** Cloudflare deletes only an empty bucket. */
export async function deleteBucket(key: BucketKey): Promise<void> {
  await cloudflare(
    "DELETE",
    bucketPath(key),
    undefined,
    jurisdictionHeader(key.jurisdiction),
  );
}
