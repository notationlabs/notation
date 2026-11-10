import { deprecatedPermission } from "../lambda/deprecated-permission";

/**
 * @deprecated Use `lambda.LambdaPermission`. Kept so that deploy can delete
 * the statements that this resource created, as orphans.
 */
export const LambdaEventBridgeRulePermission = deprecatedPermission(
  "aws/eventBridge/LambdaEventBridgeRulePermission",
);
