---
"@notation/1password": minor
---

A new package, `@notation/1password`, with one source, `OnePasswordSecret`. It takes an `op://` secret reference, and has one credential, `value`. It reads items with the 1Password CLI, `op`, which must be installed, and which signs in with the desktop app, a service account or a Connect server.

- Plan and deploy fetch every item at the start, before any resource changes: the first item in one call, alone, and the others at most eight at a time. A shell with no approval shows one prompt.
- The revision is the item's ID and version. `track: "hmac"` or `track: "scrypt"` makes it a hash of the field's value instead.
- A reference with a query attribute, such as `?attribute=otp`, or an item name that starts with `-`, fails in the constructor.
- The package exports `OnePasswordError` and `ItemReplacedError`.
