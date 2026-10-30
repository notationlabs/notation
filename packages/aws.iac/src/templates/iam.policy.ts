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

export type PolicyStatement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};

export type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};
