# Contributing

Every task in this repository runs through `pok`. Run `pok` on its own to list
the commands, or `pok <command> --help` for one of them.

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pok build`      | Build every package                                                 |
| `pok dev`        | Watch and rebuild every package                                     |
| `pok test run`   | Run the suite once, as CI and the pre-commit hook do                |
| `pok test watch` | Re-run tests on change                                              |
| `pok test e2e`   | Build, then run the end-to-end tests against real provider accounts |
| `pok typecheck`  | Type-check every package                                            |
| `pok format`     | Format the repository                                               |

## Tests

The tests of a provider mirror its source. Each resource or construct has two
files side by side, such as `test/resources/workers/worker-script.test.ts` and
`test/resources/workers/worker-script.e2e.test.ts`:

- `<name>.test.ts` holds the unit tests. They mock the provider's API, and
  `pok test run` runs them.
- `<name>.e2e.test.ts` holds the end-to-end tests. They write a project to a
  temp directory, run the built CLI's `deploy` and `destroy` in it, and check
  the result in a real account with the provider. `pok test run` and the
  pre-commit hook leave them out. Run them with `pok test e2e`.

Each provider's end-to-end tests share one setup, in `test/e2e.ts` in the
provider's package. They read the provider's credentials from the environment.
The Cloudflare tests are skipped when any is missing, and the AWS tests fail.
Each test file names what it creates with a prefix for the run, and deletes it
when its tests end.

### Cloudflare

- Credentials: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token
  needs the Workers Scripts: Edit, Workers R2 Storage: Edit, Workers KV
  Storage: Edit and Containers: Edit permissions. The account needs a
  workers.dev subdomain and the Workers Paid plan. The tests of account tokens
  also need the Secrets Store: Edit and Account API Tokens: Edit permissions.
  They use the account's Secrets Store, or create one, and leave it.
- Prefix: `ne2e-<6 hex characters>`. A Worker, a container application, an R2
  bucket in the default or EU jurisdiction, an account API token or a Secrets
  Store secret whose name starts with `ne2e-`, or a KV namespace whose title
  starts with `ne2e-`, is left over from a run that was killed, and can be
  deleted. Delete the container application before its Worker. The exception
  is a `ne2e-lock-*` secret, which is a lock from `@notation/test-utils`.
  Delete one only if it is older than 60 minutes.
- Private registries: the `ContainerRegistry` test pulls an image from AWS
  ECR, so it also needs the AWS credentials and permissions below, and is
  skipped without them. The token also needs the Secrets Store: Edit
  permission, and the account needs a Secrets Store. The test holds the
  `container-registry` lock while it manages the account's registry record for
  `<aws account id>.dkr.ecr.<AWS_REGION>.amazonaws.com`. A record for that
  domain while no run holds the lock is left over, and can be deleted. So
  can a Secrets Store secret named `ne2e-<6 hex characters>-ecr`, which holds
  the pull user's secret access key for the record.

### AWS

- Environment: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, for an IAM
  user, and `AWS_REGION`. The provider deploys to `AWS_REGION`, and the tests
  check the results there. When any is missing, each AWS test fails with an
  error that names the missing variables. The tests are not skipped.
- The Cloudflare `ContainerRegistry` test also needs `ECR_PULL_ACCESS_KEY_ID`
  and `ECR_PULL_SECRET_ACCESS_KEY`, for a second IAM user that can only pull
  images. The `AWS_*` user creates the ECR repository and pushes the image
  into it. Cloudflare pulls the image with the pull user's keys, which the
  test gives to the registry record. The test is skipped when any of the five
  variables is missing.
- Permissions: the user needs these actions on resources whose names start
  with `ne2e-`, in that region. An organization's service control policy must
  not deny them.
  - IAM: `CreateRole`, `GetRole`, `UpdateRole`, `DeleteRole`, `PassRole`,
    `UpdateAssumeRolePolicy`, `PutRolePolicy`, `GetRolePolicy`,
    `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`,
    `ListRolePolicies`, `ListAttachedRolePolicies` and `ListRoles`.
  - Lambda: `CreateFunction`, `GetFunction`, `GetFunctionConfiguration`,
    `UpdateFunctionCode`, `UpdateFunctionConfiguration`, `DeleteFunction`,
    `ListFunctions`, `AddPermission`, `RemovePermission`, `GetPolicy`,
    `TagResource`, `UntagResource` and `ListTags`.
  - EventBridge: `CreateEventBus`, `DescribeEventBus`, `DeleteEventBus`,
    `ListEventBuses`, `PutRule`, `DescribeRule`, `DeleteRule`, `ListRules`,
    `PutTargets`, `RemoveTargets` and `ListTargetsByRule`.
  - CloudWatch Logs: `CreateLogGroup`, `PutRetentionPolicy`,
    `DescribeLogGroups` and `DeleteLogGroup`.
  - SQS: `ListQueues` and `DeleteQueue`, to find and delete leftovers.
  - STS: `GetCallerIdentity`.
  - ECR, for the Cloudflare `ContainerRegistry` test: `CreateRepository`,
    `DescribeRepositories`, `DeleteRepository`, `InitiateLayerUpload`,
    `UploadLayerPart`, `CompleteLayerUpload` and `PutImage`, to copy an image
    into a repository.
- Pull user permissions: `ecr:GetAuthorizationToken` on all resources, and
  `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and
  `ecr:BatchCheckLayerAvailability` on repositories whose names start with
  `ne2e-`, in `AWS_REGION`. Give it nothing else, as its keys are stored in
  Cloudflare.
- Prefix: `ne2e-<6 hex characters>`. An IAM role, Lambda function, EventBridge
  bus or rule, SQS queue, log group under `/aws/lambda/`, or ECR repository
  whose name starts with `ne2e-` is left over from a run that was killed, and
  can be deleted. Delete an ECR repository with its images (`force`).

## Publishing Packages

Create a changeset, when a change should result in a version bump:

```
pok release changeset
```

From the main branch, consolidate changesets, bumping the versions of affected packages:

```
pok release version
```

Then publish to the NPM registry:

```
pok release publish
```
