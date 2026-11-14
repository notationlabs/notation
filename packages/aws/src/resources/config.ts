export function region(): string {
  const value = process.env.AWS_REGION;
  if (!value) {
    throw new Error(
      "AWS_REGION is not set. Set it to the region that Notation deploys AWS resources to, such as AWS_REGION=eu-north-1.",
    );
  }
  return value;
}
