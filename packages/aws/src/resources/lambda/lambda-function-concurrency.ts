import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/resources/utils/aws-clients";
import { AwsSchema } from "src/resources/utils/types";
import { LambdaFunction, type LambdaFunctionInstance } from "./lambda";

type LambdaFunctionConcurrencyParams = {
  FunctionName: string;
  ReservedConcurrentExecutions: number;
};

export type LambdaFunctionConcurrencySchema = AwsSchema<{
  Key: Pick<LambdaFunctionConcurrencyParams, "FunctionName">;
  CreateParams: LambdaFunctionConcurrencyParams;
  ReadResult: LambdaFunctionConcurrencyParams;
}>;

export type LambdaFunctionConcurrencyDependencies = {
  lambda: LambdaFunctionInstance;
};

const lambdaFunctionConcurrency = resource<LambdaFunctionConcurrencySchema>({
  type: "aws/lambda/LambdaFunctionConcurrency",
  provider: "@notation/aws/resources",
  // A function replaced under the same name has no reservation, so deploy
  // deletes this resource first and creates it again after the function.
  blocksDeleteOf: [LambdaFunction.type],
});

const lambdaFunctionConcurrencySchema = lambdaFunctionConcurrency.defineSchema({
  FunctionName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    primaryKey: true,
  },
  ReservedConcurrentExecutions: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.number(), v.integer(), v.minValue(0)),
  },
} as const);

/**
 * The reserved concurrency of a Lambda function: the most instances of the
 * function that run at once, set aside from the account's limit. Deleting it
 * returns the function to the account's unreserved concurrency.
 */
export const LambdaFunctionConcurrency = lambdaFunctionConcurrencySchema
  .defineOperations({
    // PutFunctionConcurrency sets the value whether or not one is set, so a
    // create whose outcome is unknown can run again.
    create: async (params) => {
      await lambdaClient().send(new sdk.PutFunctionConcurrencyCommand(params));
    },
    read: async (key) => {
      try {
        const { ReservedConcurrentExecutions } = await lambdaClient().send(
          new sdk.GetFunctionConcurrencyCommand(key),
        );
        // Lambda returns no value for a function with no reservation.
        if (ReservedConcurrentExecutions === undefined) {
          throw new ResourceNotFoundError(
            `Lambda function ${key.FunctionName} has no reserved concurrency`,
          );
        }
        return { FunctionName: key.FunctionName, ReservedConcurrentExecutions };
      } catch (error) {
        if (error instanceof sdk.ResourceNotFoundException) {
          throw new ResourceNotFoundError("Lambda function was not found", {
            cause: error,
          });
        }
        throw error;
      }
    },
    update: async (key, _patch, params) => {
      await lambdaClient().send(
        new sdk.PutFunctionConcurrencyCommand({ ...params, ...key }),
      );
    },
    delete: async (key) => {
      try {
        await lambdaClient().send(
          new sdk.DeleteFunctionConcurrencyCommand(key),
        );
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<LambdaFunctionConcurrencyDependencies>()
  .deriveParams(({ deps }) => ({
    FunctionName: deps.lambda.output.FunctionName,
  }));

export type LambdaFunctionConcurrencyInstance = InstanceType<
  typeof LambdaFunctionConcurrency
>;
