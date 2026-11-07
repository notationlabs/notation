import { $lambda, http } from "@notation/aws/lambda";
import type { APIGatewayJWTProxyEventV2 } from "@notation/aws/shared";
import type { JWTClaims } from "shared/jwt";

export const lambda = $lambda({
  id: "user",
  timeout: 5,
  memory: 64,
  event: () => http(),
});

// The route's JWT authorizer adds the claims to the request.
export const handler = async (event: APIGatewayJWTProxyEventV2<JWTClaims>) => {
  return { message: event.requestContext.authorizer.jwt.claims.$username };
};
