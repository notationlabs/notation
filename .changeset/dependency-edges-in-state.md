---
"@notation/reconciler": minor
"@notation/state": minor
---

Each state record stores the IDs of the resources it depends on in `dependsOn`. Deploy and destroy delete orphans in reverse order of these edges, so removing a construct such as a Lambda deletes its policy attachment before its role. A resource whose edges change but whose params do not has only `dependsOn` rewritten, with no provider call. Records written before this change have no edges until the next deploy writes them, and until then are deleted in storage order. Destroy deletes orphans before the resources in the desired set, so an orphan is deleted before a resource it depends on. When an orphan's type is not registered, the orphans it depends on are kept too, and `reconciler.orphan-deletion.skipped` names them in `keptDependencies`. A plan node lists `dependsOn` sorted and deduplicated. `CreateResourceParams` and `UpdateResourceParams` take a required `dependsOn`.
