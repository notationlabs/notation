import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import type { JWTClaims } from "shared/jwt";

const { handle } = lambda({ id: "user", timeout: 5, memory: 64 });

export const getUserHandler = handle.jwtAuthorizedApiRequest<JWTClaims>(
  async (event) => {
    return json({
      message: event.requestContext.authorizer.jwt.claims.$username,
    });
  },
);
