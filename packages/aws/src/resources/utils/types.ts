/**
 * Fix AWS SDK types
 * For create and update: remove undefined from value
 * For read: make all options required
 */
export type AwsSchema<S extends SdkSchema> = {
  Key: S["Key"];
  CreateParams: NonUndefined<S["CreateParams"]>;
  UpdateParams: S extends { UpdateParams: infer UpdateParams }
    ? NonUndefined<UpdateParams>
    : undefined;
  ReadResult: S extends { ReadResult: infer ReadResult } ? ReadResult : {};
};

type NonUndefined<T> = {
  [P in keyof T]: Exclude<T[P], undefined>;
};

type SdkSchema = {
  Key: any;
  CreateParams: any;
  UpdateParams?: any;
  ReadResult?: any;
};
