import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import * as z from "zod";
import { lambdaClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import { fs } from "@notation/std.iac";
import { LambdaIamRoleInstance } from "./";

export type LambdaFunctionSchema = AwsSchema<{
  Key: Omit<sdk.GetFunctionRequest, "Qualifier">;
  CreateParams: sdk.CreateFunctionRequest &
    sdk.PutFunctionConcurrencyRequest & { CodeSha256: string }; // not actually a param, but want it to appear in the state for comparison
  UpdateParams: sdk.UpdateFunctionCodeRequest &
    sdk.UpdateFunctionConfigurationRequest &
    sdk.PutFunctionConcurrencyRequest &
    sdk.PutFunctionCodeSigningConfigRequest & { CodeSha256: string };
  ReadResult: sdk.GetFunctionResponse["Configuration"] &
    sdk.GetFunctionResponse["Code"] &
    sdk.GetFunctionResponse["Concurrency"];
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
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  Architectures: {
    valueType: z.array(z.enum(["x86_64", "arm64"])),
    propertyType: "param",
    presence: "optional",
  },
  Code: {
    valueType: z.object({
      S3Bucket: z.string().optional(),
      S3Key: z.string().optional(),
      S3ObjectVersion: z.string().optional(),
      ZipFile: z.any().optional(),
    }),
    propertyType: "param",
    presence: "required",
    hidden: true,
  },
  CodeSha256: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
  },
  CodeSigningConfigArn: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  CodeSigningPolicy: {
    valueType: z.enum(["Warn", "Enforce"]),
    propertyType: "param",
    presence: "optional",
  },
  DeadLetterConfig: {
    valueType: z.object({
      TargetArn: z.string(),
    }),
    propertyType: "param",
    presence: "optional",
  },
  Description: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  EphemeralStorage: {
    valueType: z.object({
      Size: z.number(),
    }),
    propertyType: "param",
    presence: "optional",
  },
  Environment: {
    valueType: z.object({
      Variables: z.record(z.string()),
    }),
    propertyType: "param",
    presence: "optional",
  },
  FileSystemConfigs: {
    valueType: z.array(
      z.object({
        Arn: z.string(),
        LocalMountPath: z.string(),
      }),
    ),
    propertyType: "param",
    presence: "optional",
  },
  FunctionArn: {
    valueType: z.string(),
    propertyType: "computed",
    presence: "required",
  },
  Handler: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  ImageConfig: {
    valueType: z.object({
      Command: z.array(z.string()),
      EntryPoint: z.array(z.string()),
      WorkingDirectory: z.string(),
    }),
    propertyType: "param",
    presence: "optional",
  },
  ImageUri: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  KMSKeyArn: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  Layers: {
    valueType: z.array(z.string()),
    propertyType: "param",
    presence: "optional",
  },
  LoggingConfig: {
    valueType: z.object({
      LogFormat: z.enum(["JSON", "Text"]),
      ApplicationLogLevel: z.enum([
        "WARN",
        "DEBUG",
        "ERROR",
        "FATAL",
        "INFO",
        "TRACE",
      ]),
      SystemLogLevel: z.enum(["WARN", "DEBUG", "INFO"]),
      LogGroup: z.string(),
    }),
    propertyType: "param",
    presence: "optional",
  },
  MemorySize: {
    valueType: z.number(),
    propertyType: "param",
    presence: "optional",
  },
  PackageType: {
    valueType: z.enum(["Zip", "Image"]),
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  Publish: {
    valueType: z.boolean(),
    propertyType: "param",
    presence: "optional",
  },
  ReservedConcurrentExecutions: {
    valueType: z.number(),
    propertyType: "param",
    presence: "required",
  },
  RevisionId: {
    valueType: z.string(),
    propertyType: "computed",
    presence: "required",
    volatile: true,
  },
  Role: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
  },
  Runtime: {
    valueType: z.enum([
      "dotnet6",
      "dotnet8",
      "dotnetcore1.0",
      "dotnetcore2.0",
      "dotnetcore2.1",
      "dotnetcore3.1",
      "go1.x",
      "java11",
      "java17",
      "java21",
      "java8",
      "java8.al2",
      "nodejs",
      "nodejs10.x",
      "nodejs12.x",
      "nodejs14.x",
      "nodejs16.x",
      "nodejs18.x",
      "nodejs20.x",
      "nodejs22.x",
      "nodejs4.3",
      "nodejs4.3-edge",
      "nodejs6.10",
      "nodejs8.10",
      "provided",
      "provided.al2",
      "provided.al2023",
      "python2.7",
      "python3.10",
      "python3.11",
      "python3.12",
      "python3.13",
      "python3.6",
      "python3.7",
      "python3.8",
      "python3.9",
      "ruby2.5",
      "ruby2.7",
      "ruby3.2",
      "ruby3.3",
    ]),
    propertyType: "param",
    presence: "optional",
  },
  SigningConfigArn: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  SigningJobArn: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  SigningProfileVersionArn: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  SnapStart: {
    valueType: z.object({
      ApplyOn: z.enum(["None", "PublishedVersions"]),
    }),
    propertyType: "param",
    presence: "optional",
  },
  State: {
    valueType: z.enum(["Active", "Pending", "Inactive", "Failed"]),
    propertyType: "computed",
    presence: "required",
  },
  Tags: {
    valueType: z.record(z.string()),
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  Timeout: {
    valueType: z.number(),
    propertyType: "param",
    presence: "optional",
  },
  TracingConfig: {
    valueType: z.object({
      Mode: z.enum(["Active", "PassThrough"]),
    }),
    propertyType: "param",
    presence: "optional",
  },
  VpcConfig: {
    valueType: z.object({
      SecurityGroupIds: z.array(z.string()),
      SubnetIds: z.array(z.string()),
    }),
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
