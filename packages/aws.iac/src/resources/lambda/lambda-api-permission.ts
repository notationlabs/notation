import { deprecatedPermission } from "./deprecated-permission";

/**
 * @deprecated Use `lambda.LambdaPermission`. Kept so that deploy can delete
 * the statements that this resource created, as orphans.
 */
export const LambdaApiGatewayV2Permission = deprecatedPermission(
  "aws/lambda/LambdaApiGatewayV2Permission",
);
