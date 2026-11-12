import * as v from "valibot";
import {
  resource,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-cloudwatch-logs";
import {
  GetFunctionCommand,
  ResourceNotFoundException as FunctionNotFoundException,
} from "@aws-sdk/client-lambda";
import {
  cloudWatchLogsClient,
  lambdaClient,
} from "src/resources/utils/aws-clients";
import { awsCreate } from "src/resources/utils/errors";
import { AwsSchema } from "src/resources/utils/types";
import { LambdaFunctionInstance } from "../lambda";

export type LambdaLogGroupSchema = AwsSchema<{
  Key: sdk.DeleteLogGroupRequest;
  CreateParams: sdk.CreateLogGroupRequest & sdk.PutRetentionPolicyRequest;
}>;

export type LambdaLogGroupDependencies = { lambda: LambdaFunctionInstance };

const LOG_GROUP_PREFIX = "/aws/lambda/";

const lambdaLogGroup = resource<LambdaLogGroupSchema>({
  type: "aws/lambda/LambdaLogGroup",
  provider: "@notation/aws/resources",
});

const lambdaLogGroupSchema = lambdaLogGroup.defineSchema({
  logGroupName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    primaryKey: true,
  },
  kmsKeyId: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  tags: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.string()),
  },
  retentionInDays: {
    propertyType: "param",
    presence: "required",
    value: v.number(),
  },
} as const);

export const LambdaLogGroup = lambdaLogGroupSchema
  .defineOperations({
    ownership: "parent",
    create: awsCreate(
      async (params) => {
        const command = new sdk.CreateLogGroupCommand(params);
        await cloudWatchLogsClient().send(command);
        const retentionCommand = new sdk.PutRetentionPolicyCommand({
          logGroupName: params.logGroupName,
          retentionInDays: params.retentionInDays,
        });
        try {
          await cloudWatchLogsClient().send(retentionCommand);
        } catch (error) {
          // The log group exists, so the outcome is unknown, not failed.
          // Deploy then finds the log group and sets its retention.
          throw new ResourceCreationUnknownError(
            `The log group was created, but its retention policy was not set: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      },
      {
        alreadyExists: (error) =>
          error instanceof sdk.ResourceAlreadyExistsException,
      },
    ),
    // Lambda makes the log group itself when the function first logs, and
    // keeps it after the function is deleted. So a log group that exists may
    // belong to an earlier function of the same name. `find` accepts only a
    // log group made after the function was last modified, because Lambda
    // does not report when a function was created.
    find: async (params) => {
      const logGroup = await describeLogGroup(params.logGroupName);
      if (logGroup?.creationTime !== undefined) {
        const modified = await functionLastModified(params.logGroupName);
        if (modified !== undefined && logGroup.creationTime >= modified) return;
      }
      throw new ResourceNotFoundError(
        "No log group was made after the function that it belongs to",
      );
    },
    read: async (key) => {
      const logGroup = await describeLogGroup(key.logGroupName);
      if (!logGroup) {
        throw new ResourceNotFoundError("Log group was not found");
      }
      // A log group whose events never expire has no retention. It is read
      // as 0, which AWS does not accept as a retention, so drift detection
      // sees the difference and sets the retention policy.
      return {
        logGroupName: key.logGroupName,
        retentionInDays: logGroup.retentionInDays ?? 0,
      };
    },
    // Each param is set by its own API call, so only the calls for the
    // params in the patch are made.
    update: async (key, patch, params) => {
      const { logGroupName } = key;
      if ("retentionInDays" in patch) {
        await cloudWatchLogsClient().send(
          new sdk.PutRetentionPolicyCommand({
            logGroupName,
            retentionInDays: params.retentionInDays,
          }),
        );
      }
      if ("kmsKeyId" in patch) {
        if (params.kmsKeyId) {
          await cloudWatchLogsClient().send(
            new sdk.AssociateKmsKeyCommand({
              logGroupName,
              kmsKeyId: params.kmsKeyId,
            }),
          );
        } else {
          await cloudWatchLogsClient().send(
            new sdk.DisassociateKmsKeyCommand({ logGroupName }),
          );
        }
      }
      if ("tags" in patch) await setTags(logGroupName, params.tags ?? {});
    },
    delete: async (key) => {
      try {
        await cloudWatchLogsClient().send(new sdk.DeleteLogGroupCommand(key));
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<LambdaLogGroupDependencies>()
  .deriveParams(({ deps }) => ({
    logGroupName: `${LOG_GROUP_PREFIX}${deps.lambda.output.FunctionName}`,
  }));

async function describeLogGroup(
  logGroupName: string,
): Promise<sdk.LogGroup | undefined> {
  const { logGroups } = await cloudWatchLogsClient().send(
    new sdk.DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }),
  );
  return logGroups?.find((group) => group.logGroupName === logGroupName);
}

/** Makes the log group's tags equal to `tags`. */
async function setTags(
  logGroupName: string,
  tags: Record<string, string>,
): Promise<void> {
  const logGroup = await describeLogGroup(logGroupName);
  if (!logGroup) throw new ResourceNotFoundError("Log group was not found");
  // `arn` ends in ":*", which the tagging calls do not accept.
  const resourceArn = logGroup.logGroupArn ?? logGroup.arn!.replace(/:\*$/, "");
  const current = await cloudWatchLogsClient().send(
    new sdk.ListTagsForResourceCommand({ resourceArn }),
  );
  const removed = Object.keys(current.tags ?? {}).filter(
    (name) => !(name in tags),
  );
  if (removed.length > 0) {
    await cloudWatchLogsClient().send(
      new sdk.UntagResourceCommand({ resourceArn, tagKeys: removed }),
    );
  }
  if (Object.keys(tags).length > 0) {
    await cloudWatchLogsClient().send(
      new sdk.TagResourceCommand({ resourceArn, tags }),
    );
  }
}

/**
 * The time in milliseconds at which the log group's function was last
 * modified, or undefined when the function does not exist.
 */
async function functionLastModified(
  logGroupName: string,
): Promise<number | undefined> {
  if (!logGroupName.startsWith(LOG_GROUP_PREFIX)) return undefined;
  try {
    const { Configuration } = await lambdaClient().send(
      new GetFunctionCommand({
        FunctionName: logGroupName.slice(LOG_GROUP_PREFIX.length),
      }),
    );
    return Configuration?.LastModified
      ? Date.parse(Configuration.LastModified)
      : undefined;
  } catch (error) {
    if (error instanceof FunctionNotFoundException) return undefined;
    throw error;
  }
}

export type LambdaLogGroupInstance = InstanceType<typeof LambdaLogGroup>;
