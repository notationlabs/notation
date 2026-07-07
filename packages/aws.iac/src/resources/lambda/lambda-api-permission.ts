import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import { ApiInstance } from "src/resources/api-gateway/api";
import { generateApiGatewaySourceArn } from "src/templates/arn";
import { LambdaFunctionInstance } from "./lambda";

export type LambdaApiGatewayV2PermissionSchema = AwsSchema<{
  Key: sdk.RemovePermissionRequest;
  CreateParams: sdk.AddPermissionRequest;
}>;

export type LambdaApiGatewayV2PermissionDependencies = {
  lambda: LambdaFunctionInstance;
  api: ApiInstance;
};

const lambdaApiGatewayV2Permission =
  resource<LambdaApiGatewayV2PermissionSchema>({
    type: "aws/lambda/LambdaApiGatewayV2Permission",
  });

const lambdaApiGatewayV2PermissionSchema =
  lambdaApiGatewayV2Permission.defineSchema({
    FunctionName: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
    },
    StatementId: {
      propertyType: "param",
      presence: "required",
      secondaryKey: true,
    },
    Qualifier: {
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
    },
    RevisionId: {
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
    },
    Action: {
      propertyType: "param",
      presence: "required",
    },
    Principal: {
      propertyType: "param",
      presence: "required",
    },
    FunctionUrlAuthType: {
      propertyType: "param",
      presence: "optional",
    },
    InvocationType: {
      propertyType: "param",
      presence: "optional",
    },
    Policy: {
      propertyType: "computed",
      presence: "optional",
    },
    PrincipalOrgID: {
      propertyType: "param",
      presence: "optional",
    },
    SourceArn: {
      propertyType: "param",
      presence: "optional",
    },
    EventSourceToken: {
      propertyType: "param",
      presence: "optional",
    },
    SourceAccount: {
      propertyType: "param",
      presence: "optional",
    },
  } as const);

export const LambdaApiGatewayV2Permission = lambdaApiGatewayV2PermissionSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.AddPermissionCommand(params);
      await lambdaClient.send(command);
    },
    delete: async (key) => {
      const command = new sdk.RemovePermissionCommand(key);
      await lambdaClient.send(command);
    },
  })
  .requireDependencies<LambdaApiGatewayV2PermissionDependencies>()
  .deriveParams(async ({ deps }) => ({
    FunctionName: deps.lambda.output.FunctionName,
    StatementId: "lambda-api-gateway-v2-permission",
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com",
    SourceArn: await generateApiGatewaySourceArn(deps.api.output.ApiId!),
  }));

export type LambdaApiGatewayV2PermissionInstance = InstanceType<
  typeof LambdaApiGatewayV2Permission
>;
