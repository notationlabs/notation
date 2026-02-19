import { resource } from "@notation/resource";
import * as z from "zod";
import * as sdk from "@aws-sdk/client-cloudfront";
import { AwsSchema } from "src/utils/types";

type DistributionSchema = AwsSchema<{
  Key: Omit<sdk.DeleteDistributionRequest, "IfMatch"> & {
    ETag: string;
  };
  CreateParams: NonNullable<
    sdk.CreateDistributionRequest["DistributionConfig"]
  >;
  ReadResult: Omit<
    NonNullable<sdk.GetDistributionResult["Distribution"]>,
    "DistributionConfig"
  > &
    NonNullable<
      sdk.GetDistributionResult["Distribution"]
    >["DistributionConfig"] & { ETag: string };
  UpdateParams: sdk.UpdateDistributionRequest["Id"] &
    NonNullable<sdk.UpdateDistributionRequest["DistributionConfig"]>;
}>;

const distribution = resource<DistributionSchema>({
  type: "aws/cloudFront/Distribution",
});

export const distributionSchema = distribution.defineSchema({
  Id: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    valueType: z.string(),
  },
  ETag: {
    propertyType: "computed",
    presence: "required",
    secondaryKey: true,
    valueType: z.string(),
  },
  ARN: {
    propertyType: "computed",
    presence: "required",
    valueType: z.string(),
  },
  ActiveTrustedKeyGroups: {
    propertyType: "computed",
    presence: "optional",
    valueType: z.object({
      Enabled: z.boolean(),
      Quantity: z.number(),
      Items: z
        .array(
          z.object({
            KeyGroupId: z.string().optional(),
            KeyPairIds: z
              .object({
                Quantity: z.number(),
                Items: z.array(z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
  },
  ActiveTrustedSigners: {
    propertyType: "computed",
    presence: "optional",
    valueType: z.object({
      Enabled: z.boolean(),
      Quantity: z.number(),
      Items: z
        .array(
          z.object({
            AwsAccountNumber: z.string().optional(),
            KeyPairIds: z
              .object({
                Quantity: z.number(),
                Items: z.array(z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
  },
  Aliases: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      Quantity: z.number(),
      Items: z.array(z.string()),
    }),
  },
  AliasICPRecordals: {
    propertyType: "computed",
    presence: "optional",
    valueType: z.array(
      z.object({
        CNAME: z.string().optional(),
        ICPRecordalStatus: z
          .enum(["APPROVED", "PENDING", "SUSPENDED"])
          .optional(),
      }),
    ),
  },
  CacheBehaviors: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      Quantity: z.number(),
      Items: z.array(
        getCacheBehaviourSchema().extend({
          PathPattern: z.string(),
        }),
      ),
    }),
  },
  CallerReference: {
    propertyType: "param",
    presence: "required",
    valueType: z.string(),
  },
  Comment: {
    propertyType: "param",
    presence: "required",
    valueType: z.string(),
  },
  ContinuousDeploymentPolicyId: {
    propertyType: "param",
    presence: "optional",
    valueType: z.string(),
  },
  CustomErrorResponses: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      Quantity: z.number(),
      Items: z.array(
        z.object({
          ErrorCode: z.number(),
          ResponsePagePath: z.string().optional(),
          ResponseCode: z.string().optional(),
          ErrorCachingMinTTL: z.number(),
        }),
      ),
    }),
  },
  DefaultCacheBehavior: {
    propertyType: "param",
    presence: "required",
    valueType: getCacheBehaviourSchema(),
  },
  DefaultRootObject: {
    propertyType: "param",
    presence: "optional",
    valueType: z.string(),
  },
  DomainName: {
    propertyType: "computed",
    presence: "required",
    valueType: z.string(),
  },
  Enabled: {
    propertyType: "param",
    presence: "required",
    valueType: z.boolean(),
  },
  HttpVersion: {
    propertyType: "param",
    presence: "optional",
    valueType: z.enum(["http1.1", "http2"]),
  },
  InProgressInvalidationBatches: {
    propertyType: "computed",
    presence: "optional",
    valueType: z.number(),
  },
  IsIPV6Enabled: {
    propertyType: "param",
    presence: "optional",
    valueType: z.boolean(),
  },
  LastModifiedTime: {
    propertyType: "computed",
    presence: "required",
    valueType: z.date(),
  },
  Logging: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      Bucket: z.string(),
      Enabled: z.boolean(),
      IncludeCookies: z.boolean(),
      Prefix: z.string(),
    }),
  },
  OriginGroups: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      Quantity: z.number(),
      Items: z.array(
        z.object({
          Id: z.string(),
          FailoverCriteria: z.object({
            StatusCodes: z.object({
              Quantity: z.number(),
              Items: z.array(z.number()),
            }),
          }),
          Members: z.object({
            Quantity: z.number(),
            Items: z.array(z.object({ OriginId: z.string() })),
          }),
        }),
      ),
    }),
  },
  Origins: {
    propertyType: "param",
    valueType: z.object({
      Quantity: z.number(),
      Items: z.array(
        z.object({
          Id: z.string(),
          DomainName: z.string(),
          OriginPath: z.string().optional(),
          // todo
          CustomHeaders: z.any(),
          // todo
          S3OriginConfig: z.any().optional(),
          // todo
          CustomOriginConfig: z.any().optional(),
          ConnectionsAttempts: z.number().optional(),
          ConnectionTimeout: z.number().optional(),
          OriginShield: z.any().optional(),
          OriginAccessControlId: z.string().optional(),
        }),
      ),
    }),
    presence: "required",
  },
  PriceClass: {
    propertyType: "param",
    presence: "optional",
    valueType: z.enum(["PriceClass_100", "PriceClass_200", "PriceClass_All"]),
  },
  Restrictions: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      GeoRestriction: z.object({
        RestrictionType: z.enum(["none", "blacklist", "whitelist"]),
        Quantity: z.number(),
        Items: z.array(z.string()).optional(),
      }),
    }),
  },
  Staging: {
    propertyType: "param",
    presence: "optional",
    valueType: z.boolean(),
  },
  Status: {
    propertyType: "computed",
    presence: "required",
    valueType: z.string(),
  },
  ViewerCertificate: {
    propertyType: "param",
    presence: "optional",
    valueType: z.object({
      ACMCertificateArn: z.string().optional(),
      IAMCertificateId: z.string().optional(),
      CloudFrontDefaultCertificate: z.boolean().optional(),
      SNIEnabled: z.boolean().optional(),
      MinimumProtocolVersion: z
        .enum([
          "SSLv3",
          "TLSv1",
          "TLSv1.1_2016",
          "TLSv1_2016",
          "TLSv1.2_2018",
          "TLSv1.2_2019",
          "TLSv1.2_2021",
        ])
        .optional(),
      Certificate: z.string().optional(),
      CertificateSource: z.enum(["acm", "cloudfront", "iam"]).optional(),
    }),
  },
  WebACLId: {
    propertyType: "param",
    presence: "optional",
    valueType: z.string(),
  },
});

function getCacheBehaviourSchema() {
  return z.object({
    ViewerProtocolPolicy: z.enum([
      "allow-all",
      "https-only",
      "redirect-to-https",
    ]),
    TargetOriginId: z.string(),
    // todo make required
    CachePolicyId: z.string().optional(),
    TrustedSigners: z
      .object({
        Enabled: z.boolean(),
        Quantity: z.number(),
        Items: z.array(z.string()).optional(),
      })
      .optional(),
    TrustedKeyGroups: z
      .object({
        Enabled: z.boolean(),
        Quantity: z.number(),
        Items: z.array(z.string()).optional(),
      })
      .optional(),
    AllowedMethods: z
      .object({
        Quantity: z.number(),
        Items: z.array(
          z.enum(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]),
        ),
        CachedMethods: z
          .object({
            Quantity: z.number(),
            Items: z.array(
              z.enum([
                "DELETE",
                "GET",
                "HEAD",
                "OPTIONS",
                "PATCH",
                "POST",
                "PUT",
              ]),
            ),
          })
          .optional(),
      })
      .optional(),
    SmoothStreaming: z.boolean().optional(),
    Compress: z.boolean().optional(),
    LambdaFunctionAssociations: z
      .object({
        Quantity: z.number(),
        Items: z
          .array(
            z.object({
              LambdaFunctionARN: z.string(),
              EventType: z.enum([
                "origin-request",
                "origin-response",
                "viewer-request",
                "viewer-response",
              ]),
              IncludeBody: z.boolean(),
            }),
          )
          .optional(),
      })
      .optional(),
    FieldLevelEncryptionId: z.string().optional(),
    // todo deprecate
    ForwardedValues: z
      .object({
        QueryString: z.boolean(),
        Cookies: z.object({
          Forward: z.enum(["all", "none", "whitelist"]),
          WhitelistedNames: z
            .object({
              Quantity: z.number(),
              Items: z.array(z.string()).optional(),
            })
            .optional(),
        }),
        Headers: z
          .object({
            Quantity: z.number(),
            Items: z.array(z.string()).optional(),
          })
          .optional(),
        QueryStringCacheKeys: z
          .object({
            Quantity: z.number(),
            Items: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
    MinTTL: z.number().optional(),
    MaxTTL: z.number().optional(),
    DefaultTTL: z.number().optional(),
  });
}
