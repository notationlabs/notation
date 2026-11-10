import * as v from "valibot";
import { type ResourceType } from "@notation/resource";
import { resource } from "src/resource";
import { removeStatement } from "./lambda-permission";
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
      delete: removeStatement,
    });
}
