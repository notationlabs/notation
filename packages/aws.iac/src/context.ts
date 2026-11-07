import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { stsClient } from "src/utils/aws-clients";

const command = new GetCallerIdentityCommand({});

export const getAwsAccountId = async () => {
  const response = await stsClient().send(command);
  return response.Account;
};
