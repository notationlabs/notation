import type {
  CompoundKey,
  ComputedPrimaryKey,
  Output,
  Params,
  ResolveSchema,
  Result,
  SchemaFromApi,
  State,
} from "../src/index";

// Stress case for generic type instantiation.
// Intentionally type-only; no runtime code.

type ApiKey = {
  orgId: string;
  projectId: string;
  env: "dev" | "prod";
  id: string;
};

type ApiCreateParams = ApiKey & {
  // required
  name: string;
  region: "us-east-1" | "us-west-2" | "eu-west-1";
  size: "s" | "m" | "l";
  enabled: boolean;
  ownerEmail: string;
  tags: string[];
  // optional
  description?: string;
  kmsKeyArn?: string;
  retentionDays?: number;
  featureFlagA?: boolean;
  featureFlagB?: boolean;
  // lots of params to scale mapped types
  p01: string;
  p02: string;
  p03: string;
  p04: string;
  p05: string;
  p06: string;
  p07: string;
  p08: string;
  p09: string;
  p10: string;
  p11: string;
  p12: string;
  p13: string;
  p14: string;
  p15: string;
  p16: string;
  p17: string;
  p18: string;
  p19: string;
  p20: string;
  p21: string;
  p22: string;
  p23: string;
  p24: string;
  p25: string;
  p26: string;
  p27: string;
  p28: string;
  p29: string;
  p30: string;
  p31: string;
  p32: string;
  p33: string;
  p34: string;
  p35: string;
  p36: string;
  p37: string;
  p38: string;
  p39: string;
  p40: string;
  // optional tail
  q01?: string;
  q02?: string;
  q03?: string;
  q04?: string;
  q05?: string;
  q06?: string;
  q07?: string;
  q08?: string;
  q09?: string;
  q10?: string;
};

type ApiUpdateParams = ApiKey & {
  // subset of create params is patchable
  name?: string;
  description?: string;
  enabled?: boolean;
  tags?: string[];
  retentionDays?: number;
  featureFlagA?: boolean;
  featureFlagB?: boolean;
  p01?: string;
  p02?: string;
  p03?: string;
  p04?: string;
  p05?: string;
  p06?: string;
  p07?: string;
  p08?: string;
  p09?: string;
  p10?: string;
  p11?: string;
  p12?: string;
  p13?: string;
  p14?: string;
  p15?: string;
};

type ApiReadResult = ApiCreateParams & {
  // computed
  createdAt: string;
  updatedAt: string;
  etag: string;
  status: "creating" | "ready" | "error";
  endpointUrl?: string;
  lastErrorMessage?: string;
  // more computed
  c01: string;
  c02: string;
  c03: string;
  c04: string;
  c05: string;
  c06: string;
  c07: string;
  c08: string;
  c09: string;
  c10: string;
  c11: string;
  c12: string;
  c13: string;
  c14: string;
  c15: string;
};

type Prefixed<T, P extends string> = {
  [K in keyof T as K extends string ? `${P}${K}` : never]: T[K];
};

type V1Create = ApiCreateParams & Prefixed<Omit<ApiCreateParams, keyof ApiKey>, "v1_">;
type V1Read = ApiReadResult & Prefixed<Omit<ApiReadResult, keyof ApiKey>, "v1_">;
type V2Create = ApiCreateParams & Prefixed<Omit<ApiCreateParams, keyof ApiKey>, "v2_">;
type V2Read = ApiReadResult & Prefixed<Omit<ApiReadResult, keyof ApiKey>, "v2_">;
type V3Create = ApiCreateParams & Prefixed<Omit<ApiCreateParams, keyof ApiKey>, "v3_">;
type V3Read = ApiReadResult & Prefixed<Omit<ApiReadResult, keyof ApiKey>, "v3_">;
type V4Create = ApiCreateParams & Prefixed<Omit<ApiCreateParams, keyof ApiKey>, "v4_">;
type V4Read = ApiReadResult & Prefixed<Omit<ApiReadResult, keyof ApiKey>, "v4_">;
type V5Create = ApiCreateParams & Prefixed<Omit<ApiCreateParams, keyof ApiKey>, "v5_">;
type V5Read = ApiReadResult & Prefixed<Omit<ApiReadResult, keyof ApiKey>, "v5_">;

type Api1 = {
  Key: ApiKey;
  CreateParams: V1Create;
  UpdateParams: ApiUpdateParams;
  ReadResult: V1Read;
};
type S1 = ResolveSchema<
  Api1,
  SchemaFromApi<ApiKey, V1Create, ApiUpdateParams, V1Read>
>;
type Api2 = {
  Key: ApiKey;
  CreateParams: V2Create;
  UpdateParams: ApiUpdateParams;
  ReadResult: V2Read;
};
type S2 = ResolveSchema<
  Api2,
  SchemaFromApi<ApiKey, V2Create, ApiUpdateParams, V2Read>
>;
type Api3 = {
  Key: ApiKey;
  CreateParams: V3Create;
  UpdateParams: ApiUpdateParams;
  ReadResult: V3Read;
};
type S3 = ResolveSchema<
  Api3,
  SchemaFromApi<ApiKey, V3Create, ApiUpdateParams, V3Read>
>;
type Api4 = {
  Key: ApiKey;
  CreateParams: V4Create;
  UpdateParams: ApiUpdateParams;
  ReadResult: V4Read;
};
type S4 = ResolveSchema<
  Api4,
  SchemaFromApi<ApiKey, V4Create, ApiUpdateParams, V4Read>
>;
type Api5 = {
  Key: ApiKey;
  CreateParams: V5Create;
  UpdateParams: ApiUpdateParams;
  ReadResult: V5Read;
};
type S5 = ResolveSchema<
  Api5,
  SchemaFromApi<ApiKey, V5Create, ApiUpdateParams, V5Read>
>;

export type _Stress1 = {
  key: CompoundKey<S1>;
  params: Params<S1>;
  state: State<S1>;
  result: Result<S1>;
  output: Output<S1>;
  computedPrimaryKey: ComputedPrimaryKey<S1>;
};

export type _Stress2 = {
  key: CompoundKey<S2>;
  params: Params<S2>;
  state: State<S2>;
  result: Result<S2>;
  output: Output<S2>;
  computedPrimaryKey: ComputedPrimaryKey<S2>;
};

export type _Stress3 = {
  key: CompoundKey<S3>;
  params: Params<S3>;
  state: State<S3>;
  result: Result<S3>;
  output: Output<S3>;
  computedPrimaryKey: ComputedPrimaryKey<S3>;
};

export type _Stress4 = {
  key: CompoundKey<S4>;
  params: Params<S4>;
  state: State<S4>;
  result: Result<S4>;
  output: Output<S4>;
  computedPrimaryKey: ComputedPrimaryKey<S4>;
};

export type _Stress5 = {
  key: CompoundKey<S5>;
  params: Params<S5>;
  state: State<S5>;
  result: Result<S5>;
  output: Output<S5>;
  computedPrimaryKey: ComputedPrimaryKey<S5>;
};
