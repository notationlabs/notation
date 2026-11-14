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
  needs the Workers Scripts: Edit permission, and the account needs a
  workers.dev subdomain.
- Prefix: `ne2e-<6 hex characters>`. A Worker whose name starts with `ne2e-` is
  left over from a run that was killed, and can be deleted.
- Account locks: some resources can't have a name with the run's prefix,
  because the account can have only one of them, such as a container registry
  for a domain. A test that manages such a resource must hold that resource's
  lock, so that only one run at a time uses it. The lock is a Secrets Store
  secret named `ne2e-lock-<name>`, whose comment holds the run's prefix and the
  time it took the lock, so the token also needs the Secrets Store: Edit
  permission. The tests use the account's store, or create one and leave it.

  ```ts
  import { useAccountLock } from "../account-lock";

  describeE2e("ContainerRegistry", () => {
    // Before useProject, so that the lock is released after the destroy.
    useAccountLock("container-registry");
    const project = useProject();
    // ...
  });
  ```

  Outside a `describe`, `withAccountLock(name, async () => { ... })` holds the
  lock while the function runs. A run waits up to 15 minutes for another run's
  lock, and then fails with an error that names the holder. A `ne2e-lock-*`
  secret older than 30 minutes is left over from a run that was killed. The
  next run that wants the lock deletes it and takes it. Don't delete a younger
  one, as another run holds it.

### AWS

- Environment: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, for an IAM
  user, and `AWS_REGION`. The provider deploys to `AWS_REGION`, and the tests
  check the results there. When any is missing, each AWS test fails with an
  error that names the missing variables. The tests are not skipped.
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
- Prefix: `ne2e-<6 hex characters>`. An IAM role, Lambda function, EventBridge
  bus or rule, SQS queue, or log group under `/aws/lambda/` whose name starts
  with `ne2e-` is left over from a run that was killed, and can be deleted.

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
