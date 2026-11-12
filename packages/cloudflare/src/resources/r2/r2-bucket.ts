import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  createBucket,
  deleteBucket,
  getBucket,
  isBucketAlreadyExists,
  isBucketNotEmpty,
  isNoSuchBucket,
  jurisdictionSchema,
  locationHintSchema,
  setBucketStorageClass,
  storageClassSchema,
  type BucketKey,
  type Jurisdiction,
  type LocationHint,
  type StorageClass,
} from "src/api/r2";

type R2BucketKey = {
  AccountId: string;
  BucketName: string;
  Jurisdiction: Jurisdiction;
};

export type R2BucketSchema = {
  Key: R2BucketKey;
  CreateParams: R2BucketKey & {
    LocationHint?: LocationHint;
    StorageClass: StorageClass;
  };
  UpdateParams: { StorageClass: StorageClass };
  ReadResult: {};
};

const r2Bucket = resource<R2BucketSchema>({
  type: "cloudflare/r2/R2Bucket",
  provider: "@notation/cloudflare/resources",
});

const r2BucketSchema = r2Bucket.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  BucketName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.string(),
  },
  /**
   * Where Cloudflare stores the bucket's objects. Every request for a bucket
   * outside `default` names its jurisdiction, so it is part of the key.
   */
  Jurisdiction: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: jurisdictionSchema,
  },
  /**
   * Where Cloudflare places the bucket when it creates it. Cloudflare can
   * place it elsewhere, so the read doesn't return the hint.
   */
  LocationHint: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: locationHintSchema,
  },
  /** The storage class of new objects, unless an upload sets another. */
  StorageClass: {
    propertyType: "param",
    presence: "required",
    value: storageClassSchema,
  },
} as const);

const bucketKey = (key: R2BucketKey): BucketKey => ({
  account: key.AccountId,
  name: key.BucketName,
  jurisdiction: key.Jurisdiction,
});

const inAccount = (key: R2BucketKey) =>
  key.Jurisdiction === "default"
    ? `the Cloudflare account ${key.AccountId}`
    : `the ${key.Jurisdiction} jurisdiction of the Cloudflare account ${key.AccountId}`;

function alreadyExists(key: R2BucketKey, cause?: unknown): Error {
  return new Error(
    `A bucket named ${key.BucketName} already exists in ${inAccount(key)}. Give the bucket another name, or delete the existing bucket and deploy again.`,
    { cause },
  );
}

export const R2Bucket = r2BucketSchema.defineOperations({
  // Cloudflare rejects a name that the account has already. The check
  // still runs first: after a create with an unknown outcome, the
  // reconciler reads the key, and it would take a bucket that existed
  // before as the one the create made. The check is outside
  // `cloudflareCreate`: if it throws, nothing was created.
  create: async (params) => {
    const key = bucketKey(params);
    if (await getBucket(key)) throw alreadyExists(params);
    try {
      await cloudflareCreate(createBucket)(key, {
        locationHint: params.LocationHint,
        storageClass: params.StorageClass,
      });
    } catch (error) {
      if (isBucketAlreadyExists(error)) throw alreadyExists(params, error);
      throw error;
    }
  },

  read: async (key) => {
    const bucket = await getBucket(bucketKey(key));
    if (!bucket) {
      throw new ResourceNotFoundError("R2 bucket was not found");
    }
    return {
      AccountId: key.AccountId,
      BucketName: key.BucketName,
      Jurisdiction: key.Jurisdiction,
      StorageClass: bucket.storage_class ?? undefined,
    };
  },

  update: async (key, _patch, params) => {
    await setBucketStorageClass(bucketKey(key), params.StorageClass);
  },

  delete: async (key) => {
    try {
      await deleteBucket(bucketKey(key));
    } catch (error) {
      if (isNoSuchBucket(error)) return;
      if (isBucketNotEmpty(error)) {
        throw new Error(
          `The bucket ${key.BucketName} in ${inAccount(key)} still has objects, and Cloudflare deletes only an empty bucket. Delete its objects, then try again.`,
          { cause: error },
        );
      }
      throw error;
    }
  },

  deriveParams: () => ({ AccountId: accountId() }),
});

export type R2BucketInstance = InstanceType<typeof R2Bucket>;
