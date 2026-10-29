import { ResourceGroup } from "@notation/core";

export class AwsResourceGroup<
  C extends Record<string, any> = Record<string, any>,
> extends ResourceGroup<C> {
  platform = "aws";
}
