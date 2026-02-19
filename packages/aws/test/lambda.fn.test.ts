import { test, expect } from "vitest";
import { handle, json } from "src/lambda.fn";
import { APIGatewayProxyEventV2JWT } from "src/shared";
import { Context } from "aws-lambda";

test("handlers wrap user-provided handlers", async () => {
  const fn = async () => ({ body: "{}" });
  for (const handler of Object.values(handle)) {
    const result = await handler(fn)({} as any, {} as any);
    expect(result).toEqual({ body: "{}" });
  }
});

test("jwtAuthorizedApiRequest passes through JWT token as expected", async () => {
  type ClaimsFields = {
    iss: string;
  };

  const jwtTokenHandler = handle.jwtAuthorizedApiRequest<ClaimsFields>(
    (event: APIGatewayProxyEventV2JWT<ClaimsFields>, context: Context) => {
      return {
        body: JSON.stringify({
          name: event.requestContext.jwt.claims.iss,
        }),
      };
    },
  );

  const input: APIGatewayProxyEventV2JWT<ClaimsFields> = {
    requestContext: {
      jwt: {
        claims: {
          iss: "John Doe",
        },
        scopes: [],
      },
    },
    headers: {},
    routeKey: "",
    rawPath: "",
    isBase64Encoded: false,
    rawQueryString: "",
    version: "1",
  };

  const result = await jwtTokenHandler(input, {} as Context);

  expect(result).toEqual({ body: JSON.stringify({ name: "John Doe" }) });
});

test("json returns a JSON string and a 200 status code", () => {
  const payload = { message: "Hello, world!" };
  const response = json(payload);
  expect(response.statusCode).toEqual(200);
  expect(response.body).toEqual(JSON.stringify(payload));
});
