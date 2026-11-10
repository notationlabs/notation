import {
  resource as defineResource,
  type DefineResourceApiSchema,
  type DefineResourceMeta,
} from "@notation/resource";

export const provider = "@notation/aws.iac";

/** `resource()` from `@notation/resource`, with this package as the provider. */
export function resource<ApiSchema extends DefineResourceApiSchema>(
  meta: Omit<DefineResourceMeta, "provider">,
) {
  return defineResource<ApiSchema>({ ...meta, provider });
}
