import type { Input } from "@notation/resource";

export const lambdaTrustPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AllowAssumeRole",
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com",
      },
      Action: "sts:AssumeRole",
    },
  ],
};

type StringOrStrings = string | string[];

export type ConditionValue = string | number | boolean;

export type PolicyPrincipal = "*" | Record<string, StringOrStrings>;

/**
 * A statement in the IAM policy grammar. A statement has either `Action` or
 * `NotAction`, and either `Resource` or `NotResource`. A resource can be an
 * output ref or a derived value, such as a queue's `arn` or
 * `` text`${queue.arn}-*` ``. The role policy's params hold each statement
 * with its resources filled in, as a `ResolvedPolicyStatement`.
 */
export type PolicyStatement<R = Input<string>> = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: PolicyPrincipal;
  NotPrincipal?: PolicyPrincipal;
  Condition?: Record<string, Record<string, ConditionValue | ConditionValue[]>>;
} & (
  | { Action: StringOrStrings; NotAction?: never }
  | { NotAction: StringOrStrings; Action?: never }
) &
  (
    | { Resource: R | R[]; NotResource?: never }
    | { NotResource: R | R[]; Resource?: never }
  );

/** A statement with its resources filled in, as the role policy holds it. */
export type ResolvedPolicyStatement = PolicyStatement<string>;

/**
 * A policy document. IAM accepts a single statement object in place of the
 * array; the role policy's read turns it into an array.
 */
export type PolicyDocument = {
  Version?: "2012-10-17" | "2008-10-17";
  Id?: string;
  Statement: ResolvedPolicyStatement[];
};
