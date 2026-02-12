import { lambda } from "@notation/aws/lambda";
import { execSync } from "node:child_process";

execSync("cd exo && exo deploy aws-lambda");

lambda({
  id: "exograph",
  handler: "bootstrap",
  runtime: "provided.al2023",
  code: {
    type: "zip",
    path: "exo/target/aws-lambda/function.zip",
  },
});

// todo
// memorySize: 2048,
// timeout: cdk.Duration.seconds(30),
// environment: {
//   DATABASE_URL: env.DB_URL,
// },
