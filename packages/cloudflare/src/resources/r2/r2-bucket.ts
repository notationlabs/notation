import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  createBucket,
  deleteBucket,
  getBucket,
  isBucketNotEmpty,
  isNoSuchBucket,
  jurisdictionSchema,
  locationHintSchema,
  setBucketStorageClass,
  storageClassSchema,
  type Jurisdiction,
  type LocationHint,
  type StorageClass,
} from "src/api/r2";

type R2BucketKey = {
  AccountId: string;
  BucketName: string;
  Jurisdiction: Jurisdiction;
};

type R2BucketParams = {
  LocationHint?: LocationHint;
  StorageClass: StorageClass;
};

export type R2BucketSchema = {
  Key: R2BucketKey;
  CreateParams: R2BucketKey & R2BucketParams;
  UpdateParams: R2BucketParams;
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
   * Where Cloudflare stores the bucket's objects. Every request for the
   * bucket names its jurisdiction, so it is part of the key.
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
   * place it elsewhere, so the read doesn't return the hint. A change to the
   * hint doesn't move a bucket that exists.
   */
  LocationHint: {
    propertyType: "param",
    presence: "optional",
    hidden: true,
    value: locationHintSchema,
  },
  /** The storage class of new objects, unless an upload sets another. */
  StorageClass: {
    propertyType: "param",
    presence: "required",
    value: storageClassSchema,
  },
} as const);

const inAccount = (key: R2BucketKey) =>
  `the ${key.Jurisdiction} jurisdiction of the Cloudflare account ${key.AccountId}`;

export const R2Bucket = r2BucketSchema.defineOperations({
  // Check first, so an existing bucket isn't taken as this create's. The
  // check is outside `cloudflareCreate`: if it throws, nothing was created.
  create: async (params) => {
    const { AccountId, BucketName, Jurisdiction } = params;
    if (await getBucket(AccountId, BucketName, Jurisdiction)) {
      throw new Error(
        `A bucket named ${BucketName} already exists in ${inAccount(params)}. Give the bucket another name, or delete the existing bucket and deploy again.`,
      );
    }
    await cloudflareCreate(createBucket)(AccountId, BucketName, Jurisdiction, {
      locationHint: params.LocationHint,
      storageClass: params.StorageClass,
    });
  },

  read: async (key) => {
    const bucket = await getBucket(
      key.AccountId,
      key.BucketName,
      key.Jurisdiction,
    );
    if (!bucket) {
      throw new ResourceNotFoundError("R2 bucket was not found");
    }
    return {
      AccountId: key.AccountId,
      BucketName: key.BucketName,
      Jurisdiction: key.Jurisdiction,
      StorageClass: bucket.storage_class,
    };
  },

  update: async (key, _patch, params) => {
    await setBucketStorageClass(
      key.AccountId,
      key.BucketName,
      key.Jurisdiction,
      params.StorageClass,
    );
  },

  delete: async (key) => {
    try {
      await deleteBucket(key.AccountId, key.BucketName, key.Jurisdiction);
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
