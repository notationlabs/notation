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
    rejectReplace: (previous, desired) =>
      `CLOUDFLARE_ACCOUNT_ID is ${desired}, but this R2 bucket was created in the account ${previous}. An R2 bucket can't move to another account, and replacing it would delete the old bucket first. Set CLOUDFLARE_ACCOUNT_ID back to ${previous} to keep the bucket. To start fresh in the other account, first run \`notation destroy\` with the old account, or deploy to another stage.`,
    value: v.string(),
  },
  /**
   * 3 to 64 lowercase letters, digits and hyphens. The name can't start or
   * end with a hyphen.
   */
  BucketName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    rejectReplace: (previous, desired) =>
      `The bucket name is ${desired}, but this R2 bucket was created as ${previous}. An R2 bucket can't be renamed, and replacing it would delete the old bucket first. Set the name back to ${previous} to keep the bucket. To start fresh, first run \`notation destroy\`, or deploy to another stage.`,
    value: v.pipe(
      v.string(),
      v.regex(
        /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
        "An R2 bucket name must be 3 to 64 lowercase letters, digits and hyphens, and can't start or end with a hyphen.",
      ),
    ),
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
    rejectReplace: (previous, desired) =>
      `The jurisdiction is ${desired}, but this R2 bucket was created in the ${previous} jurisdiction. An R2 bucket can't move to another jurisdiction, and replacing it would delete the old bucket first. Set the jurisdiction back to ${previous} to keep the bucket. To start fresh in the other jurisdiction, first run \`notation destroy\`, or deploy to another stage.`,
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
      // Cloudflare can leave out the storage class. The default is Standard.
      StorageClass: bucket.storage_class ?? "Standard",
    };
  },

  // StorageClass is the only param that an update can change, so the update
  // always sends the PATCH.
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
