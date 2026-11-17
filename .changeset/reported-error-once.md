---
"@notation/reconciler": minor
"@notation/core": minor
"@notation/cli": patch
---

A failed operation's error is printed once. Before, the CLI printed the `✗` line of the operation, then printed the same error again with its stack and cause.

- The reconciler sets `reportedOperation` on an error when it emits the error's `✗` event. The field gives the operation, the resource ID, and the credential for `rotate` and `load`. It survives the durable runtime's copy of the error. `findReportedError` returns the error, or the first error in its cause chain, that has the field. `@notation/core` exports it.
- The CLI prints one line for a reported error, such as `notation destroy stopped because delete router-bucket failed.`. When another error wraps the reported error, such as an `UnobtainableCredentialError` with the deploy command to run, the CLI also prints that error's message. It prints any other error in full, with its stack. `NOTATION_DEBUG=1` prints every error in full.
- `watch` no longer prints `Deploy exited with code 1` with a stack after a failed deploy. The child process prints the error. `deployInChild` resolves with the child's exit code instead of rejecting.
