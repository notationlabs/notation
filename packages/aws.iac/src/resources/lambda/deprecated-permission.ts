import * as v from "valibot";
import * as sdk from "@aws-sdk/client-lambda";
import { resource, type ResourceType } from "@notation/resource";
import { lambdaClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";

type DeprecatedPermissionKey = { FunctionName: string; StatementId: string };

type DeprecatedPermissionSchema = AwsSchema<{
  Key: DeprecatedPermissionKey;
  CreateParams: DeprecatedPermissionKey;
}>;

/**
 * Defines a permission class that can only delete the statement of a state
 * record that a removed permission resource wrote. Deploy deletes such a
 * record as an orphan through this class. The schema has only the key, as
 * delete needs nothing else.
 */
export function deprecatedPermission(type: ResourceType) {
  return resource<DeprecatedPermissionSchema>({
    type,
    provider: "@notation/aws.iac",
  })
    .defineSchema({
      FunctionName: {
        propertyType: "param",
        presence: "required",
        primaryKey: true,
        value: v.string(),
      },
      StatementId: {
        propertyType: "param",
        presence: "required",
        secondaryKey: true,
        value: v.string(),
      },
    } as const)
    .defineOperations({
      create: async () => {
        throw new Error(
          `${type} can no longer be created. Use lambda.LambdaPermission.`,
        );
      },
      delete: async (key) => {
        try {
          await lambdaClient().send(new sdk.RemovePermissionCommand(key));
        } catch (error) {
          if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
        }
      },
    });
}
