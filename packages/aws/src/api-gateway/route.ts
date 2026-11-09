import * as aws from "@notation/aws.iac";
import type { StandardSchemaV1 } from "@notation/resource";
import {
  declarationOf,
  eventCall,
  resolveLambda,
  whenLoaded,
} from "src/lambda/lambda-declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import type { ApiGroup } from "./api";
import type { HttpMethod } from "src/lambda/declaration";
import type { JwtAuthorizerGroup } from "./auth";

type RouteGroupConfig = {
  apiGroup: ApiGroup;
  method: HttpMethod;
  path: `/${string}`;
  auth?: JwtAuthorizerGroup<any>;
  lambdaGroup: LambdaGroup;
};

export class RouteGroup extends aws.AwsResourceGroup {
  readonly route: aws.apiGateway.RouteInstance;

  constructor({ apiGroup, method, path, auth, lambdaGroup }: RouteGroupConfig) {
    const apiResource = apiGroup.api;
    const routeId = `${apiResource.id}-${method}-${path}`;
    const routeKey = `${method} ${path}`;
    super("API Gateway/Route", routeId);

    const lambdaResource = lambdaGroup.fn;

    // a lambda needs one integration and permission per api, however many
    // routes it serves
    const integration = lambdaGroup.addOnce(
      aws.apiGateway.LambdaIntegration,
      `${apiResource.id}-${lambdaResource.id}-integration`,
      {
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
      },
    );

    lambdaGroup.addOnce(
      aws.lambda.LambdaApiGatewayV2Permission,
      `${lambdaResource.id}-${apiResource.id}-permission`,
      {
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
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
 * `apiGateway.schema(body, { claims })`, whose claims schema has the type of
 * the authorizer's. An authorizer with no claims schema takes any claims
 * schema. Both take a declaration with no event.
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
                  claims: [C] extends [undefined] ? any : C & StandardSchemaV1;
                };
              }
            : { kind: "apiGateway" });
    })
  | LambdaGroup;

/**
 * Routes requests for `method` and `path` on the API to a Lambda. A route
 * with an authorizer takes a declaration whose claims schema is the
 * authorizer's, and a route without one takes a declaration with no claims.
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
    const declaration = declarationOf(target);
    const event = declaration?.event;
    if (
      (event?.kind === "apiGateway" || event?.kind === "apiGateway-jwt") &&
      "route" in event
    ) {
      throw new Error(
        `route() routes ${routeName} to the Lambda "${declaration!.id}", which makes its own route in its declaration, with event: () => ${eventCall(event)}. Route the Lambda in one place: remove the route() call, or declare the Lambda with event: () => apiGateway.schema(body).`,
      );
    }
    const lambdaGroup = resolveLambda(target, "route()", [
      auth ? "apiGateway-jwt" : "apiGateway",
      "none",
    ]);
    // An authorizer with no claims schema is allowed, as the function still
    // validates the claims.
    if (
      auth?.claims !== undefined &&
      event?.kind === "apiGateway-jwt" &&
      auth.claims !== event.claims
    ) {
      throw new Error(
        `route() routes ${routeName} to the Lambda "${lambdaGroup.id}", but the authorizer's claims schema is not the claims schema of the Lambda's event: () => apiGateway.schema(body, { claims }), so the function would validate the claims with another schema. Give jwtAuthorizer() and apiGateway.schema() the same claims schema, imported from a shared module.`,
      );
    }
    new RouteGroup({ apiGroup, method, path, auth, lambdaGroup });
  });
}
