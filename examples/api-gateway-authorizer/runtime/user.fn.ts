import type { LambdaConfig } from "@notation/aws/lambda.fn";
import { handle, json } from "@notation/aws/lambda.fn";
import type { JWTClaims } from "shared/jwt";

export const getUserHandler = handle.jwtAuthorizedApiRequest<JWTClaims>(
  async (event) => {
    return json({
      message: event.requestContext.authorizer.jwt.claims.$username,
    });
  },
);

export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "user",
  timeout: 5,
  memory: 64,
};
