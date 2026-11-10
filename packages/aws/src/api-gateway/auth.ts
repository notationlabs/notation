import * as aws from "src/resources";
import { AwsResourceGroup } from "src/shared/resource-group";
import type { StandardSchemaV1 } from "@notation/resource";
import type { AuthorizerSource } from "src/lambda/declaration";
import { assertId, assertName, resourceId, type IdOption } from "src/id";
import { claimAwsName, describeDeclaration } from "src/naming";
import type { ApiGroup } from "./api";

export type JwtAuthorizerConfig<
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  /**
   * Keys the authorizer in state, with its API's id. Two APIs can each have
   * an authorizer with the same id. Changing the id replaces the authorizer,
   * so keep it stable. Must be name-safe: 1 to 64 letters, digits, hyphens
   * or underscores.
   */
  id: string;
  /**
   * The authorizer's name in AWS, in place of the id. The authorizer belongs
   * to its API, whose name already has the app and stage, so the name has no
   * prefix. Must be name-safe.
   */
  name?: string;
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
  extends AwsResourceGroup<JwtAuthorizerConfig>
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
    assertId("jwtAuthorizer()", rest.id);
    assertName("jwtAuthorizer()", rest.name);
    const name = rest.name ?? rest.id;
    const authId = resourceId("api-authorizer", api.id, rest.id);
    super("API Gateway/JWT Authorizer", authId, { api, ...rest });
    // Authorizer names are unique within their API.
    claimAwsName(
      `JWT authorizers of the API "${api.id}"`,
      name,
      describeDeclaration("jwtAuthorizer()", rest.id, rest.name),
    );
    this.api = api;
    this.claims = claims as C;
    this.scopes = rest.scopes ?? [];
    this.auth = this.add(
      new aws.apiGateway.RouteAuth(authId, {
        config: {
          Name: name,
          AuthorizerType: "JWT",
          IdentitySource: ["$request.header.Authorization"],
          JwtConfiguration: {
            Audience: rest.audience,
            Issuer: rest.issuer,
          },
        },
        dependencies: { api: api.api },
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
 * the authorizer holds only its claims schema. `id` must be a name-safe
 * string literal; see `NameSafe`.
 * @resource runtime: claims
 */
export function jwtAuthorizer<
  C extends StandardSchemaV1 | undefined = undefined,
  const Id extends string = never,
>(
  config: Omit<JwtAuthorizerConfig<C>, "id"> & { id: IdOption<Id> },
): JwtAuthorizerGroup<C> {
  return new JwtAuthorizerGroup(config);
}
