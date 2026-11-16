---
"@notation/resource": patch
"@notation/reconciler": patch
"@notation/core": patch
"@notation/dashboard": patch
---

Resource groups can nest. `ResourceGroup.add()` takes a group as well as a resource, so a group that builds on another, such as one that calls `kvJson()`, can hold it with `this.add(kvJson({ ... }))`. A group has at most one parent, and adding a group that already has one, or adding a group to itself or to a group it contains, throws. A group lists the groups added to it in `groups`, and exposes its parent's ref as `parent` and its own as `ref`.

`ResourceGroupRef` now has a required `parents` field, which lists the groups that contain the group, outermost first, and is `[]` at the top level. Deploy writes it to each record, and rewrites the record without calling the provider when a resource's ancestry changes, as it does when its group changes. `notation viz` draws a nested group as a subgraph inside its parent's, and the dashboard lists groups as a tree.
