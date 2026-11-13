import type { Redacted } from "@notation/core";

export type SourceContext = {
  stage: string;
};

export type Source = {
  /** Shown in plan, and stored in the value resource's params, such as "infisical". */
  name: string;
  /** True if the source has a value for the key. */
  has(key: string, context: SourceContext): Promise<boolean>;
  /** The key's version. Left out by sources that have no versions. */
  version?(key: string, context: SourceContext): Promise<string>;
  get(key: string, context: SourceContext): Promise<Redacted<string>>;
};
