import * as aws from "src/resources";
import { AwsResourceGroup } from "src/resource-group";
import type { StandardSchemaV1 } from "@notation/resource";
import { resolveLambda, whenLoaded } from "src/lambda/lambda-declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import type { ApiGroup } from "./api";
import type { HttpMethod } from "src/lambda/declaration";
import type { JwtAuthorizerGroup } from "./auth";
import { resourceId } from "src/id";

type RouteGroupConfig = {
  apiGroup: ApiGroup;
  method: HttpMethod;
  path: `/${string}`;
  auth?: JwtAuthorizerGroup<any>;
  lambdaGroup: LambdaGroup;
};

export class RouteGroup extends AwsResourceGroup {
  readonly route: aws.apiGateway.RouteInstance;

  constructor({ apiGroup, method, path, auth, lambdaGroup }: RouteGroupConfig) {
    const apiResource = apiGroup.api;
    const routeKey = `${method} ${path}`;
    // The route key is last, as a path may hold `:`.
    const routeId = resourceId("api-route", apiGroup.id, routeKey);
    super("API Gateway/Route", routeId);

    const lambdaResource = lambdaGroup.fn;

    // a lambda needs one integration and permission per api, however many
    // routes it serves
    const integration = lambdaGroup.addOnce(
      aws.apiGateway.LambdaIntegration,
      resourceId("api-integration", apiGroup.id, lambdaGroup.id),
      {
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
      },
    );

    lambdaGroup.addOnce(
      aws.lambda.LambdaPermission,
      resourceId("api-permission", apiGroup.id, lambdaGroup.id),
      {
        config: {
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          SourceArn: apiResource.outputRef("ExecuteApiSourceArn"),
        },
        dependencies: { lambda: lambdaResource },
      },
    );

    this.route = this.add(
      new aws.apiGateway.Route(routeId, {
        config: {
          AuthorizationScopes: auth?.scopes ?? [],
          RouteKey: routeKey,
          AuthorizationType: auth ? "JWT" : "NONE",
        },
        dependencies: {
          api: apiResource,
          lambdaIntegration: integration,
          auth: auth?.auth,
        },
      }),
    );
  }
}

/**
 * A Lambda that a route invokes: a declaration from `$lambda`, passed as
 * `() => lambda`, or a Lambda group from `lambda()`. A route with no
 * authorizer takes a declaration with `apiGateway.schema(body)`. A route with
 * an authorizer takes a declaration with
 * `apiGateway.schema(body).authSchema(claims)`, whose claims schema has the
 * type of the authorizer's, or with `authSchema()` and no claims schema. An
 * authorizer with no claims schema takes any claims schema. Both take a
 * declaration with no event.
 */
export type ApiGatewayTarget<
  A extends JwtAuthorizerGroup<any> | undefined = undefined,
> =
  | (() => {
      readonly "~lambda"?:
        | { kind: "none" }
        | (A extends JwtAuthorizerGroup<infer C>
            ? {
                kind: "apiGateway-jwt";
                event: {
                  claims: [C] extends [undefined]
                    ? any
                    : (C & StandardSchemaV1) | undefined;
                };
              }
            : { kind: "apiGateway" });
    })
  | LambdaGroup;

/**
 * Routes requests for `method` and `path` on the API to a Lambda. A route
 * with an authorizer takes a declaration with `authSchema()`, whose claims
 * schema is the authorizer's or unset, and a route without one takes a
 * declaration with no authorizer.
 * The route is made when infra has finished loading.
 * @resource
 */
export function route<A extends JwtAuthorizerGroup<any> | undefined>(
  apiGroup: ApiGroup,
  method: HttpMethod,
  path: `/${string}`,
  auth: A,
  target: ApiGatewayTarget<A>,
): void {
  whenLoaded(() => {
    const routeName = `${method} ${path}`;
    const { group: lambdaGroup, event } = resolveLambda(
      target,
      "route()",
      auth ? "apiGateway-jwt" : "apiGateway",
    );
    // Either side may have no claims schema. Without one in the authorizer,
    // the function still validates the claims. Without one in the
    // declaration, the function doesn't validate them.
    if (
      auth?.claims !== undefined &&
      event?.kind === "apiGateway-jwt" &&
      event.claims !== undefined &&
      auth.claims !== event.claims
    ) {
      throw new Error(
        `route() routes ${routeName} to the Lambda "${lambdaGroup.id}", but the authorizer's claims schema is not the claims schema of the Lambda's event: () => apiGateway.schema(body).authSchema(claims), so the function would validate the claims with another schema. Give jwtAuthorizer() and authSchema() the same claims schema, imported from a shared module.`,
      );
    }
    new RouteGroup({ apiGroup, method, path, auth, lambdaGroup });
  });
}
