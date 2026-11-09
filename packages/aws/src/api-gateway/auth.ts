import * as aws from "@notation/aws.iac";
import type { StandardSchemaV1 } from "@notation/resource";
import type { AuthorizerSource } from "src/lambda/declaration";
import type { ApiGroup } from "./api";
import { authorizerKey, mapAuthConfig } from "./utils";

export type JwtAuthorizerConfig<
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  /** The API whose routes the authorizer guards, from `api()`. */
  api: ApiGroup;
  /** The URL of the token's issuer, such as `https://example.auth0.com/`. */
  issuer: string;
  /** The audiences that a token must be issued for. */
  audience: string[];
  /** The scopes that a token must have, on each route of the authorizer. */
  scopes?: string[];
  /**
   * Validates the token's claims, in `decode()` of a Lambda that a route of
   * the authorizer invokes. A Lambda declared with
   * `apiGateway.schema(body).authSchema(claims)` must be given this schema,
   * or no schema. Import
   * it from a shared module, so the function can load it.
   */
  claims?: C;
};

// Marks a JwtAuthorizerGroup across installed copies of this package, as for
// LambdaGroup.
const authorizerMark = Symbol.for("@notation/aws/JwtAuthorizerGroup");

export class JwtAuthorizerGroup<
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
>
  extends aws.AwsResourceGroup<JwtAuthorizerConfig>
  implements AuthorizerSource<C>
{
  readonly api: ApiGroup;
  readonly auth: aws.apiGateway.AuthInstance;
  readonly claims: C;
  readonly scopes: string[];

  get [authorizerMark]() {
    return true;
  }

  constructor(config: JwtAuthorizerConfig<C>) {
    const { api, claims, ...rest } = config;
    const apiResource = api.api;
    // An API allows 10 authorizers. The id keeps the issuer and audience, so
    // a second authorizer with the same ones is a duplicate.
    const id = `${apiResource.id}-jwt-authorizer-${authorizerKey(rest)}`;
    super("API Gateway/JWT Authorizer", id, { api, ...rest });
    this.api = api;
    this.claims = claims as C;
    this.scopes = rest.scopes ?? [];
    this.auth = this.add(
      new aws.apiGateway.RouteAuth(id, {
        config: mapAuthConfig(apiResource.id, rest),
        dependencies: { api: apiResource },
      }),
    );
  }
}

export function isJwtAuthorizerGroup(
  value: unknown,
): value is JwtAuthorizerGroup {
  return (value as any)?.[authorizerMark] === true;
}

/**
 * Declares a JWT authorizer on an API. Routes take it with
 * `router(api).withAuthorizer(authorizer)`, and a Lambda takes it with
 * `apiGateway.bind(api).defineRoute({ auth: authorizer })`. In the function,
 * the authorizer holds only its claims schema.
 * @resource runtime: claims
 */
export function jwtAuthorizer<
  C extends StandardSchemaV1 | undefined = undefined,
>(config: JwtAuthorizerConfig<C>): JwtAuthorizerGroup<C> {
  return new JwtAuthorizerGroup(config);
}
