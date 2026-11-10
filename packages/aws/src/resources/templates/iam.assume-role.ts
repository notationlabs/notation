export function assumeRolePolicyForPrincipal(principal: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowAssumeRole",
        Effect: "Allow",
        Principal: principal,
        Action: "sts:AssumeRole",
      },
    ],
  };
}
