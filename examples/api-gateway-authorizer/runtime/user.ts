import { $lambda, http, jwt, type LambdaHandler } from "@notation/aws/lambda";
import type { JWTClaims } from "shared/jwt";

export const lambda = $lambda({
  id: "user",
  timeout: 5,
  memory: 64,
  event: () => http({ auth: jwt<JWTClaims>() }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  return { message: event.requestContext.authorizer.jwt.claims.$username };
};
