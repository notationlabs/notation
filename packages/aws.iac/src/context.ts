import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { stsClient } from "src/utils/aws-clients";

let accountId: Promise<string> | undefined;

// The account is fixed for the process, and `read` of every API asks for it,
// so it is fetched once. A failed fetch is not kept.
export const getAwsAccountId = (): Promise<string> => {
  accountId ??= stsClient()
    .send(new GetCallerIdentityCommand({}))
    .then((response) => response.Account!)
    .catch((error) => {
      accountId = undefined;
      throw error;
    });
  return accountId;
};
