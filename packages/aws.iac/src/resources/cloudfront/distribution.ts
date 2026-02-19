import * as sdk from "@aws-sdk/client-cloudfront";
import { cloudFrontClient } from "src/utils/aws-clients";
import { ExcludeUndefined } from "src/utils/types";
import { ApiInstance } from "../api-gateway/api";
import { distributionSchema } from "./distribution.schema";

type DistributionDependencies = {
  origin: ApiInstance;
};

export const Distribution = distributionSchema
  .defineOperations({
    async create(params) {
      const command = new sdk.CreateDistributionCommand({
        DistributionConfig: params,
      });
      const result = await cloudFrontClient.send(command);
      return { Id: result.Distribution!.Id! };
    },
    async read(key) {
      const command = new sdk.GetDistributionCommand(key);
      const result = await cloudFrontClient.send(command);
      const { DistributionConfig, ...Distribution } = result.Distribution!;
      const payload = {
        ...Distribution,
        ...DistributionConfig,
        ETag: result.ETag,
      };
      return payload as ExcludeUndefined<typeof payload>;
    },
    async update(key, patch, params, state) {
      const readCommand = new sdk.GetDistributionCommand(key);
      const readResult = await cloudFrontClient.send(readCommand);
      const command = new sdk.UpdateDistributionCommand({
        Id: key.Id,
        IfMatch: readResult.ETag,
        // soft rewrite e.g. not reading current state in
        // so will fail if state is out of date
        DistributionConfig: { ...state, ...patch },
      });
      await cloudFrontClient.send(command);
    },
    async delete(key, state) {
      let ETag = key.ETag;
      if (state.Enabled) {
        const updateCommand = new sdk.UpdateDistributionCommand({
          Id: key.Id,
          IfMatch: state.ETag,
          DistributionConfig: {
            ...state,
            Enabled: false,
          },
        });
        // todo: store in state in case delete fails
        const updateResult = await cloudFrontClient.send(updateCommand);
        ETag = updateResult.ETag!;
      }
      // todo: wait until the distribution is actually disabled
      const deleteCommand = new sdk.DeleteDistributionCommand({
        Id: key.Id,
        IfMatch: ETag,
      });
      await cloudFrontClient.send(deleteCommand);
    },
  })
  .requireDependencies<DistributionDependencies>()
  .deriveParams(({ deps }) => ({
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: `cf-origin-${deps.origin.id}`,
          DomainName: deps.origin.output.ApiEndpoint.replace("https://", ""),
          CustomHeaders: {
            Quantity: 0,
            Items: [],
          },
          CustomOriginConfig: {
            OriginProtocolPolicy: "https-only",
            HTTPPort: 80,
            HTTPSPort: 443,
          },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: `cf-origin-${deps.origin.id}`,
      ViewerProtocolPolicy: "https-only",
      // CachePolicyId: "",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
        },
      },
      ForwardedValues: {
        QueryString: true,
        // If your application uses cookies or requires specific headers, configure them here
        Cookies: { Forward: "none" },
        Headers: {
          Quantity: 1,
          Items: ["Origin"], // Specify the headers you want to forward to the origin
        },
      },
      MinTTL: 1,
    },
  }));

export type DistributionInstance = InstanceType<typeof Distribution>;
