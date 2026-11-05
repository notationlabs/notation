import type { LambdaResource } from "@notation/aws/lambda/runtime";
import { handle } from "@notation/aws/lambda/runtime";
import type { JWTClaims } from "shared/jwt";

export const getUserHandler = handle.jwtAuthorizedApiRequest<JWTClaims>(
  async (event) => {
    return {
      message: event.requestContext.authorizer.jwt.claims.$username,
    };
  },
);

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "user",
  timeout: 5,
  memory: 64,
};
