import { test, expect } from "vitest";
import { handle, json } from "src/lambda.fn";
import { APIGatewayJWTProxyEventV2 } from "src/shared";
import { Context } from "aws-lambda";

test("handlers wrap user-provided handlers", async () => {
  const fn = async (): Promise<any> => ({ body: "{}" });
  const result = await handle.apiRequest(fn)({} as any, {} as any);
  expect(result).toEqual({ body: "{}" });
});

test("jwtAuthorizedApiRequest passes through JWT token as expected", async () => {
  type ClaimsFields = {
    iss: string;
  };

  const jwtTokenHandler = handle.jwtAuthorizedApiRequest<ClaimsFields>(
    (event: APIGatewayJWTProxyEventV2<ClaimsFields>, context: Context) => {
      return {
        body: JSON.stringify({
          name: event.requestContext.authorizer.jwt.claims.iss,
        }),
      };
    },
  );

  const input: APIGatewayJWTProxyEventV2<ClaimsFields> = {
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            iss: "John Doe",
          },
          scopes: [],
        },
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
