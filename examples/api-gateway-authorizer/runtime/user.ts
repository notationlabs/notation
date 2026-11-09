import {
  $lambda,
  apiGateway,
  DecodeError,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { userApi, userAuth } from "infra/api";

// The declaration makes its own route, GET /user, behind the authorizer.
export const lambda = $lambda({
  id: "user",
  timeout: 5,
  memory: 64,
  event: () =>
    apiGateway
      .bind(userApi)
      .defineRoute({ method: "GET", path: "/user", auth: userAuth }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  try {
    // A GET has no body, so decode() only validates the claims.
    await lambda.decode(event);
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 403, body: error.message };
  }
  return { message: event.requestContext.authorizer.jwt.claims.$username };
};
