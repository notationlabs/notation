import {
  $lambda,
  apiGateway,
  DecodeError,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { JWTClaims } from "shared/jwt";

// infra/api.ts routes GET /profile to this function, behind an authorizer
// with the same claims schema.
export const lambda = $lambda({
  id: "profile",
  timeout: 5,
  memory: 64,
  event: () => apiGateway.schema(undefined, { claims: JWTClaims }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  try {
    await lambda.decode(event);
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 403, body: error.message };
  }
  const { sub, iss } = event.requestContext.authorizer.jwt.claims;
  return { sub, iss };
};
