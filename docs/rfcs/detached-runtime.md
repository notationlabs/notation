# RFC: Detached runtime

**Status:** proposed
**Scope:** `@notation/resource`, `@notation/reconciler`, runtime host

Notation currently reconciles live resource objects. The same process evaluates the
infrastructure program, constructs each resource, and runs its provider operations.

A detached runtime separates those jobs. A publisher evaluates the program and sends a
versioned deployment bundle to a long-running host. The host converges that bundle
without importing the original program.

The exported desired-state document is one part of this boundary. It does not contain
enough information to run a deployment by itself.

## The first consumer

The first implementation will be a local runtime host:

```sh
notation runtime serve --state .notation/runtime.db
notation publish infra/api.ts --runtime http://localhost:7788
```

The host accepts a deployment bundle, stores it, reconciles it, and exposes its event
stream. This local process gives each protocol a concrete consumer before the protocol
becomes public.

Cloud hosting and multi-tenancy follow the same boundary. They are not required for the
first implementation.

## Deployment bundle

A deployment bundle contains three versioned documents.

### Desired state

Desired state describes resource instances and their dependency edges:

```json
{
  "version": 1,
  "kind": "notation.desired-state",
  "deployment": "checkout-production",
  "resources": [
    {
      "id": "api-role",
      "type": "aws/iam/role",
      "params": { "RoleName": "checkout-api" }
    }
  ],
  "edges": []
}
```

The document contains stable inputs. Values which depend on another resource remain
references until reconciliation:

```json
{
  "$resource": "api-role",
  "$path": ["Arn"]
}
```

The runtime resolves the reference after `api-role` has produced an output. A generic
`after-apply` marker cannot preserve this relationship.

### Resource manifests

A manifest describes one resource type:

```json
{
  "version": 1,
  "kind": "notation.resource-manifest",
  "type": "aws/iam/role",
  "schema": {},
  "operations": ["create", "read", "update", "delete"],
  "errors": {
    "notFound": ["NoSuchEntityException"],
    "retry": ["ConcurrentModificationException"]
  },
  "actuator": "aws-primary"
}
```

The runtime uses the schema to compare desired params, stored params, and provider
output. Error policies remain data because the original TypeScript classes are absent.

### Actuator bindings

An actuator binding tells the runtime where operations execute:

```json
{
  "version": 1,
  "kind": "notation.actuator-binding",
  "name": "aws-primary",
  "transport": "http",
  "endpoint": "http://localhost:7790/actuate"
}
```

Credentials belong to the runtime configuration. They do not belong in the deployment
bundle.

## Runtime resource

The reconciler needs a resource object, but a detached host has no provider class to
instantiate. The runtime will construct a `RuntimeResource` from a desired-state node
and its manifest.

`RuntimeResource` implements `BaseResource`. Its operations delegate to the actuator
named by the manifest. Dependency references resolve against state immediately before
an operation runs.

Actuator injection is explicit:

```ts
const resource = new RuntimeResource({ node, manifest, actuator });
```

Generated resource classes will use the same constructor-level actuator contract. A
private local-actuator getter cannot form a portable boundary.

## Convergence loop

The runtime stores the latest accepted bundle before deployment:

1. Validate every document version.
2. Verify that each resource type has one manifest.
3. Verify that each manifest names an available actuator.
4. Store the complete bundle as the deployment's desired revision.
5. Hydrate runtime resources.
6. Reconcile the resources against the deployment's state backend.
7. Record the applied desired revision.
8. Publish the versioned event stream.

A newer desired revision supersedes an older queued revision. A running reconciliation
finishes under its mutation leases before the next revision starts.

## Publisher

The publisher evaluates the infrastructure program in an isolated process. It emits the
complete deployment bundle as one atomic payload.

The publisher owns TypeScript-specific work:

- loading the compiled program
- collecting resources declared during program evaluation
- resolving static configuration
- converting dependency-derived values into resource references
- collecting manifests from provider packages

The runtime remains independent of TypeScript and the source repository.

## Compatibility

Each document kind has its own integer version. The runtime rejects an unsupported
version before storing any part of the bundle.

Compatibility tests run old bundle fixtures against the current runtime. Provider
packages also test their generated manifests as snapshots. A version changes only when
an existing consumer would interpret the same document differently.

## Delivery

### 1. Local vertical slice

- local runtime host
- one local actuator over HTTP
- one resource type
- publish, create, update, restart, and destroy
- persisted desired revision and event stream

### 2. Provider manifests

- manifest builder in `@notation/resource`
- generated manifests for the AWS catalogue
- resource-reference encoding for derived params
- manifest compatibility fixtures

### 3. Runtime hardening

- authenticated actuator bindings
- deployment cancellation and supersession
- crash recovery
- event replay
- operational health endpoints

### 4. Hosted runtime

- tenant isolation
- encrypted runtime configuration
- remote state backend
- deployment history and retention

## Acceptance criteria

The detached boundary is complete when the local host passes this scenario:

1. Publish a bundle while the source project is available.
2. Stop the publisher and remove its compiled output.
3. Restart the runtime.
4. Update and destroy the deployment without importing project code.
5. Reproduce the deployment from the stored bundle and actuator configuration alone.

Until this scenario works, detached runtime formats remain internal and unversioned.

## Open questions

- Should actuator bindings be part of the bundle or runtime-owned configuration keyed
  by name?
- Which schema vocabulary is small enough for non-TypeScript runtimes?
- Should supersession wait for a running deployment or request cooperative cancellation?
- Which event history belongs in state, and which belongs in an external event store?
