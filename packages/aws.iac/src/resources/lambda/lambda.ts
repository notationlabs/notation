import {
  mergeContributions,
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import * as v from "valibot";
import { fromProjectRoot } from "@notation/core";
import crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { lambdaClient } from "src/utils/aws-clients";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";
import { awsCreate } from "src/utils/errors";
import { runLambdaMutation } from "src/utils/lambda-mutation";
import { AwsSchema } from "src/utils/types";
import { fs } from "@notation/std.iac";
import { LambdaIamRoleInstance } from "./";

export type LambdaFunctionSchema = AwsSchema<{
  Key: Omit<sdk.GetFunctionRequest, "Qualifier">;
  CreateParams: Omit<sdk.CreateFunctionRequest, "Code"> &
    sdk.PutFunctionConcurrencyRequest &
    LambdaCodeParams;
  UpdateParams: Omit<sdk.UpdateFunctionCodeRequest, "ZipFile"> &
    sdk.UpdateFunctionConfigurationRequest &
    sdk.PutFunctionConcurrencyRequest &
    sdk.PutFunctionCodeSigningConfigRequest &
    LambdaCodeParams;
  ReadResult: NonNullable<sdk.GetFunctionResponse["Configuration"]> &
    NonNullable<sdk.GetFunctionResponse["Code"]> &
    NonNullable<sdk.GetFunctionResponse["Concurrency"]>;
}>;

/**
 * The code is uploaded from a file. The params hold the path and hash of the
 * file instead of its bytes, because the reconciler records params.
 */
type LambdaCodeParams = {
  /** The zip archive to upload, relative to the project root. */
  CodeFilePath: string;
  /**
   * A base64 SHA-256 of the archive. AWS reports the same hash of the
   * uploaded code, so a read compares equal when the code is unchanged.
   */
  CodeSha256: string;
};

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
    value: v.string(),
    primaryKey: true,
  },
  Architectures: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.enum(sdk.Architecture)),
  },
  CodeFilePath: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    hidden: true,
  },
  CodeSha256: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  CodeSigningConfigArn: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  CodeSigningPolicy: {
    propertyType: "param",
    presence: "optional",
    value: v.picklist(["Warn", "Enforce"]),
  },
  DeadLetterConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({ TargetArn: v.optional(v.string()) }),
  },
  Description: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  EphemeralStorage: {
    propertyType: "param",
    presence: "optional",
    value: v.object({ Size: v.number() }),
  },
  Environment: {
    propertyType: "param",
    presence: "optional",
    value: v.object({
      Variables: v.optional(v.record(v.string(), v.string())),
    }),
    collect: mergeContributions,
  },
  FileSystemConfigs: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.object({ Arn: v.string(), LocalMountPath: v.string() })),
  },
  FunctionArn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  Handler: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  ImageConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({
      EntryPoint: v.optional(v.array(v.string())),
      Command: v.optional(v.array(v.string())),
      WorkingDirectory: v.optional(v.string()),
    }),
  },
  ImageUri: {
    propertyType: "computed",
    presence: "optional",
    value: v.string(),
  },
  KMSKeyArn: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  Layers: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.string()),
  },
  LoggingConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({
      LogFormat: v.optional(v.enum(sdk.LogFormat)),
      ApplicationLogLevel: v.optional(v.enum(sdk.ApplicationLogLevel)),
      SystemLogLevel: v.optional(v.enum(sdk.SystemLogLevel)),
      LogGroup: v.optional(v.string()),
    }),
  },
  MemorySize: {
    propertyType: "param",
    presence: "optional",
    value: v.number(),
  },
  PackageType: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.PackageType),
    immutable: true,
  },
  Publish: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  ReservedConcurrentExecutions: {
    propertyType: "param",
    presence: "required",
    value: v.number(),
  },
  RevisionId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
    volatile: true,
  },
  Role: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  Runtime: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.Runtime),
  },
  SigningConfigArn: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  SigningJobArn: {
    propertyType: "computed",
    presence: "optional",
    value: v.string(),
  },
  SigningProfileVersionArn: {
    propertyType: "computed",
    presence: "optional",
    value: v.string(),
  },
  SnapStart: {
    propertyType: "param",
    presence: "optional",
    value: v.object({ ApplyOn: v.optional(v.enum(sdk.SnapStartApplyOn)) }),
  },
  State: {
    propertyType: "computed",
    presence: "required",
    value: v.enum(sdk.State),
  },
  Tags: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.string()),
    immutable: true,
  },
  Timeout: {
    propertyType: "param",
    presence: "optional",
    value: v.number(),
  },
  TracingConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({ Mode: v.optional(v.enum(sdk.TracingMode)) }),
  },
  VpcConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({
      SubnetIds: v.optional(v.array(v.string())),
      SecurityGroupIds: v.optional(v.array(v.string())),
      Ipv6AllowedForDualStack: v.optional(v.boolean()),
    }),
  },
} as const);

export const LambdaFunction = lambdaFunctionSchema
  .defineOperations({
    // The create attempt is recorded as a tag, so `find` can tell this
    // deploy's function from another with the same name.
    create: awsCreate(async (params, _context, token) => {
      const { CodeFilePath, ...functionParams } = params;
      const command = new sdk.CreateFunctionCommand({
        ...functionParams,
        Tags: token
          ? { ...params.Tags, [CREATE_TOKEN_TAG]: createTokenTagValue(token) }
          : params.Tags,
        Code: { ZipFile: await readCode(CodeFilePath, params.CodeSha256) },
      });

      await runLambdaMutation(() => lambdaClient.send(command));

      // if (params.ReservedConcurrentExecutions) {
      //   const concurrencyCommand = new sdk.PutFunctionConcurrencyCommand({
      //     FunctionName: params.FunctionName,
      //     ReservedConcurrentExecutions: params.ReservedConcurrentExecutions,
      //   });
      //   await lambdaClient.send(concurrencyCommand);
      // }
    }),

    // A function without the token was not made by the attempt. Reporting it
    // as not found makes create fail on the name, instead of taking it over.
    find: async (params, token) => {
      try {
        const { Tags } = await lambdaClient.send(
          new sdk.GetFunctionCommand({ FunctionName: params.FunctionName }),
        );
        if (Tags?.[CREATE_TOKEN_TAG] === createTokenTagValue(token)) return;
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
      throw new ResourceNotFoundError(
        "No Lambda function has the name and the create token",
      );
    },

    read: async (key) => {
      try {
        const command = new sdk.GetFunctionCommand(key);
        const { Configuration, Concurrency } = await lambdaClient.send(command);

        if (Configuration?.State !== "Active") {
          throw new ResourceOperationPendingError(
            "Waiting for Lambda to become active",
            { retryAfterMs: 1_000 },
          );
        }
        if (!Configuration.RevisionId) {
          throw new ResourceOperationPendingError(
            "Waiting for Lambda to be deployed",
            { retryAfterMs: 1_000 },
          );
        }

        // Response shapes carry computed fields the params don't have, which
        // would read as drift; each param is returned as it is configured.
        const { VpcId, ...vpcConfig } = Configuration.VpcConfig ?? {};
        const { OptimizationStatus, ...snapStart } =
          Configuration.SnapStart ?? {};

        return {
          ...Configuration,
          Layers: Configuration.Layers?.map((layer) => layer.Arn),
          VpcConfig: Configuration.VpcConfig ? vpcConfig : undefined,
          SnapStart: Configuration.SnapStart ? snapStart : undefined,
          ...Concurrency,
        };
      } catch (error) {
        if (error instanceof sdk.ResourceNotFoundException) {
          throw new ResourceNotFoundError("Lambda function was not found", {
            cause: error,
          });
        }
        throw error;
      }
    },

    update: async (key, patch, params) => {
      const { CodeFilePath, CodeSha256, ...conf } = patch;
      // An omitted Environment leaves the variables as they were.
      if ("Environment" in conf && conf.Environment === undefined) {
        conf.Environment = { Variables: {} };
      }

      // todo: work it out so that these commands be run together. currently errors on:
      // ResourceConflictException: The operation cannot be performed at this time. An update is in progress for resource: arn...

      if (Object.keys(conf).length > 0) {
        const confCommand = new sdk.UpdateFunctionConfigurationCommand({
          ...key,
          ...conf,
        });
        await runLambdaMutation(() => lambdaClient.send(confCommand));
      }

      if (CodeSha256) {
        const codeCommand = new sdk.UpdateFunctionCodeCommand({
          ...key,
          ZipFile: await readCode(params.CodeFilePath, params.CodeSha256),
        });
        await runLambdaMutation(() => lambdaClient.send(codeCommand));
      }
    },

    delete: async (key) => {
      try {
        const command = new sdk.DeleteFunctionCommand(key);
        await runLambdaMutation(() => lambdaClient.send(command));
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<LambdaDependencies>()
  .deriveParams(async ({ deps }) => ({
    PackageType: "Zip",
    CodeFilePath: deps.zipFile.output.filePath,
    CodeSha256: deps.zipFile.output.fileSha256,
    Role: deps.role.output.Arn,
  }));

export type LambdaFunctionInstance = InstanceType<typeof LambdaFunction>;

/**
 * Reads the archive to upload. A resumed deploy reuses the params of the
 * original run, and the file may have changed since then, so the bytes must
 * still match the recorded hash.
 */
async function readCode(filePath: string, expectedSha256: string) {
  const code = await nodeFs.readFile(fromProjectRoot(filePath));
  const actualSha256 = crypto
    .createHash("sha256")
    .update(code)
    .digest("base64");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Lambda code at ${filePath} has SHA-256 ${actualSha256}, but this deploy expects ${expectedSha256}. The file changed after the deploy computed its params; start a new deploy.`,
    );
  }
  return code;
}

export type LambdaFunctionConfig = NonNullable<
  ConstructorParameters<typeof LambdaFunction>[1]
>["config"];
