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
  event: () => apiGateway.schema().authSchema(JWTClaims),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  try {
    const { claims } = await lambda.decode(event);
    return { sub: claims.sub, iss: claims.iss };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 403, body: error.message };
  }
};
