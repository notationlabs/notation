import { resource, typed } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import { fs } from "@notation/std.iac";
import { LambdaIamRoleInstance } from "./";

export type LambdaFunctionSchema = AwsSchema<{
  Key: Omit<sdk.GetFunctionRequest, "Qualifier">;
  CreateParams: sdk.CreateFunctionRequest &
    sdk.PutFunctionConcurrencyRequest & {
      CodeSha256: string; // not actually a param, but want it to appear in the state for comparison
    };
  UpdateParams: sdk.UpdateFunctionCodeRequest &
    sdk.UpdateFunctionConfigurationRequest &
    sdk.PutFunctionConcurrencyRequest &
    sdk.PutFunctionCodeSigningConfigRequest &
    Pick<sdk.CreateFunctionRequest, "Code"> & {
      CodeSha256: string;
    };
  ReadResult: NonNullable<sdk.GetFunctionResponse["Configuration"]> &
    NonNullable<sdk.GetFunctionResponse["Code"]> &
    NonNullable<sdk.GetFunctionResponse["Concurrency"]>;
}>;

export type LambdaDependencies = {
  role: LambdaIamRoleInstance;
  zipFile: fs.ZipFileInstance | fs.FileInstance;
};

const lambdaFunction = resource<LambdaFunctionSchema>({
  type: "aws/lambda/LambdaFunction",
});

const lambdaFunctionSchema = lambdaFunction.defineSchema({
  FunctionName: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  Architectures: {
    propertyType: "param",
    presence: "optional",
  },
  Code: {
    propertyType: "param",
    presence: "required",
    hidden: true,
  },
  CodeSha256: {
    propertyType: "param",
    presence: "required",
  },
  CodeSigningConfigArn: {
    propertyType: "param",
    presence: "optional",
  },
  CodeSigningPolicy: {
    valueType: typed<"Warn" | "Enforce">(),
    propertyType: "param",
    presence: "optional",
  },
  DeadLetterConfig: {
    propertyType: "param",
    presence: "optional",
  },
  Description: {
    propertyType: "param",
    presence: "optional",
  },
  EphemeralStorage: {
    propertyType: "param",
    presence: "optional",
  },
  Environment: {
    propertyType: "param",
    presence: "optional",
  },
  FileSystemConfigs: {
    propertyType: "param",
    presence: "optional",
  },
  FunctionArn: {
    propertyType: "computed",
    presence: "required",
  },
  Handler: {
    propertyType: "param",
    presence: "optional",
  },
  ImageConfig: {
    propertyType: "param",
    presence: "optional",
  },
  ImageUri: {
    propertyType: "computed",
    presence: "optional",
  },
  KMSKeyArn: {
    propertyType: "param",
    presence: "optional",
  },
  Layers: {
    propertyType: "param",
    presence: "optional",
  },
  LoggingConfig: {
    propertyType: "param",
    presence: "optional",
  },
  MemorySize: {
    propertyType: "param",
    presence: "optional",
  },
  PackageType: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  Publish: {
    propertyType: "param",
    presence: "optional",
  },
  ReservedConcurrentExecutions: {
    propertyType: "param",
    presence: "required",
  },
  RevisionId: {
    propertyType: "computed",
    presence: "required",
    volatile: true,
  },
  Role: {
    propertyType: "param",
    presence: "required",
  },
  Runtime: {
    propertyType: "param",
    presence: "optional",
  },
  SigningConfigArn: {
    valueType: typed<string>(),
    propertyType: "param",
    presence: "optional",
  },
  SigningJobArn: {
    propertyType: "computed",
    presence: "optional",
  },
  SigningProfileVersionArn: {
    propertyType: "computed",
    presence: "optional",
  },
  SnapStart: {
    propertyType: "param",
    presence: "optional",
  },
  State: {
    propertyType: "computed",
    presence: "required",
  },
  Tags: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  Timeout: {
    propertyType: "param",
    presence: "optional",
  },
  TracingConfig: {
    propertyType: "param",
    presence: "optional",
  },
  VpcConfig: {
    propertyType: "param",
    presence: "optional",
  },
} as const);

export const LambdaFunction = lambdaFunctionSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateFunctionCommand({
        ...params,
        Code: { ZipFile: params.Code.ZipFile },
      });

      await lambdaClient.send(command);

      // if (params.ReservedConcurrentExecutions) {
      //   const concurrencyCommand = new sdk.PutFunctionConcurrencyCommand({
      //     FunctionName: params.FunctionName,
      //     ReservedConcurrentExecutions: params.ReservedConcurrentExecutions,
      //   });
      //   await lambdaClient.send(concurrencyCommand);
      // }
    },

    read: async (key) => {
      const command = new sdk.GetFunctionCommand(key);
      const { Code, Configuration, Concurrency } =
        await lambdaClient.send(command);

      return {
        ...Configuration,
        Layers: Configuration!.Layers?.map((layer) => layer.Arn),
        ...Concurrency,
        Code: {
          S3Bucket: Code?.Location?.split("/")[0],
          S3Key: Code?.Location?.split("/")[1],
          S3ObjectVersion: Code?.Location?.split("/")[2],
          ZipFile: undefined,
        },
      };
    },

    update: async (key, patch, params) => {
      const { Code, CodeSha256, ...conf } = patch;

      // todo: work it out so that these commands be run together. currently errors on:
      // ResourceConflictException: The operation cannot be performed at this time. An update is in progress for resource: arn...

      if (Object.keys(conf).length > 0) {
        const confCommand = new sdk.UpdateFunctionConfigurationCommand({
          ...key,
          ...conf,
        });
        await lambdaClient.send(confCommand);
      }

      if (CodeSha256) {
        const codeCommand = new sdk.UpdateFunctionCodeCommand({
          ...key,
          ZipFile: params.Code.ZipFile,
        });
        await lambdaClient.send(codeCommand);
      }
    },

    delete: async (key) => {
      const command = new sdk.DeleteFunctionCommand(key);
      await lambdaClient.send(command);
    },
    retryLaterOnError: [
      {
        name: "InvalidParameterValueException",
        message:
          "The role defined for the function cannot be assumed by Lambda.",
        reason: "Waiting for IAM role to propagate",
      },
      {
        name: "InvalidParameterValueException",
        message: "The provided execution role does not have permissions",
        // todo: find real reason this is here
        reason: "Waiting for IAM role to propagate",
      },
    ],
    retryReadOnCondition: [
      {
        key: "State",
        value: "Active",
        reason: "Waiting for lambda to become active",
      },
      {
        key: "RevisionId",
        reason: "Waiting for lambda to be deployed",
      },
    ],
  })
  .requireDependencies<LambdaDependencies>()
  .deriveParams(async ({ deps }) => ({
    PackageType: "Zip",
    Code: { ZipFile: deps.zipFile.output.file },
    CodeSha256: deps.zipFile.output.sourceSha256,
    Role: deps.role.output.Arn,
  }));

export type LambdaFunctionInstance = InstanceType<typeof LambdaFunction>;

export type LambdaFunctionConfig = ConstructorParameters<
  typeof LambdaFunction
>[0]["config"];
