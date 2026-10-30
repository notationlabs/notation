import {
  mergeContributions,
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  typed,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { fromProjectRoot } from "@notation/core";
import crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { lambdaClient } from "src/utils/aws-clients";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";
import { awsCreate } from "src/utils/errors";
import { runLambdaMutation } from "src/utils/lambda-mutation";
import { AwsSchema } from "src/utils/types";
import { fs } from "@notation/std.iac";
import { sortedJson } from "@notation/utils";
import { LambdaIamRoleInstance } from "./";

export type LambdaFunctionSchema = AwsSchema<{
  Key: Omit<sdk.GetFunctionRequest, "Qualifier">;
  CreateParams: Omit<sdk.CreateFunctionRequest, "Code" | "Environment"> &
    sdk.PutFunctionConcurrencyRequest &
    LambdaCodeParams &
    LambdaEnvironmentParams;
  UpdateParams: Omit<sdk.UpdateFunctionCodeRequest, "ZipFile"> &
    Omit<sdk.UpdateFunctionConfigurationRequest, "Environment"> &
    sdk.PutFunctionConcurrencyRequest &
    sdk.PutFunctionCodeSigningConfigRequest &
    LambdaCodeParams &
    LambdaEnvironmentParams;
  ReadResult: Omit<
    NonNullable<sdk.GetFunctionResponse["Configuration"]>,
    "Environment"
  > &
    NonNullable<sdk.GetFunctionResponse["Code"]> &
    NonNullable<sdk.GetFunctionResponse["Concurrency"]> &
    LambdaEnvironmentParams;
}>;

type LambdaEnvironmentParams = { Environment?: LambdaEnvironment };

/**
 * The function's environment. The params hold it as structured maps, so
 * state, diff and plan see each key. `Runtime` is encoded as one variable,
 * `NOTATION_RUNTIME`, only when the function is created or updated.
 */
export type LambdaEnvironment = {
  Variables?: Record<string, string>;
  /** Values the function reads at runtime, merged key by key. */
  Runtime?: LambdaRuntimeValues;
};

export type LambdaRuntimeValues = {
  /**
   * Which export handles each event source, keyed by the ID of the binding
   * that connects the source to the function.
   */
  dispatch?: Record<string, LambdaDispatchEntry>;
};

export type LambdaDispatchEntry = {
  export: string;
  /** What identifies the event source, such as a queue's ARN. */
  match: string;
};

export const RUNTIME_VARIABLE = "NOTATION_RUNTIME";

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
    primaryKey: true,
  },
  Architectures: {
    propertyType: "param",
    presence: "optional",
  },
  CodeFilePath: {
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
    collect: mergeContributions,
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
    // The create attempt is recorded as a tag, so `find` can tell this
    // deploy's function from another with the same name.
    create: awsCreate(async (params, _context, token) => {
      const { CodeFilePath, ...functionParams } = params;
      const command = new sdk.CreateFunctionCommand({
        ...functionParams,
        Environment: encodeEnvironment(params.Environment),
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
          Environment: decodeEnvironment(Configuration.Environment),
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
      const { CodeFilePath, CodeSha256, Environment, ...rest } = patch;
      const conf: Omit<sdk.UpdateFunctionConfigurationRequest, "FunctionName"> =
        rest;
      // An omitted Environment leaves the variables as they were, so a
      // removed one is sent as no variables.
      if ("Environment" in patch) {
        conf.Environment = encodeEnvironment(Environment) ?? { Variables: {} };
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
 * Encodes the environment as AWS takes it: the variables, and the runtime
 * values as one variable of sorted JSON.
 */
function encodeEnvironment(
  environment: LambdaEnvironment | undefined,
): sdk.Environment | undefined {
  if (!environment) return undefined;
  const { Variables, Runtime } = environment;
  if (Variables && RUNTIME_VARIABLE in Variables) {
    throw new Error(
      `${RUNTIME_VARIABLE} is reserved for the function's runtime values; set Environment.Runtime instead`,
    );
  }
  if (!Runtime || Object.keys(Runtime).length === 0) return { Variables };
  return {
    Variables: { ...Variables, [RUNTIME_VARIABLE]: sortedJson.encode(Runtime) },
  };
}

/**
 * Decodes the environment AWS reports into the shape it is configured in. A
 * runtime variable that is not JSON is left among the variables, so it shows
 * as drift.
 */
function decodeEnvironment(
  environment: sdk.EnvironmentResponse | undefined,
): LambdaEnvironment | undefined {
  const { [RUNTIME_VARIABLE]: encoded, ...variables } =
    environment?.Variables ?? {};
  let runtime: LambdaRuntimeValues | undefined;
  if (encoded !== undefined) {
    try {
      runtime = sortedJson.decode(encoded) as LambdaRuntimeValues;
    } catch {
      variables[RUNTIME_VARIABLE] = encoded;
    }
  }
  const decoded: LambdaEnvironment = {};
  if (Object.keys(variables).length > 0) decoded.Variables = variables;
  if (runtime) decoded.Runtime = runtime;
  return Object.keys(decoded).length > 0 ? decoded : undefined;
}

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
