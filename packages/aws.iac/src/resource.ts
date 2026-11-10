import {
  resource as defineResource,
  type DefineResourceApiSchema,
  type DefineResourceMeta,
} from "@notation/resource";

export const provider = "@notation/aws.iac";

export function resource<ApiSchema extends DefineResourceApiSchema>(
  meta: Omit<DefineResourceMeta, "provider">,
) {
  return defineResource<ApiSchema>({ ...meta, provider });
}
