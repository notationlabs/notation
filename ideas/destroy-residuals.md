# Destroy workflow — residual ideas

The destroy/refresh reconciliation this branch explored is **largely superseded** by the merged
`@notation/reconciler` (destroy + refresh workflows, TASK-012). Captured here only for the
residual ideas worth revisiting:

- **Zip as an IAC resource:** model the side-effectful zip/packaging step as a first-class IAC
  resource rather than an inline build step, so it participates in the graph and state.
  (Overlaps the not-yet-merged `deterministic-zip` package on `spike/package-split-004-007`.)
- **Move async requests out of the graph-compilation path** — keep graph compilation pure;
  defer network calls to reconciliation.
- **Deploy + visualisation commands** — early CLI ergonomics, now covered by the CLI package.

**Source branch (archaeology):** `spike/destroy` (~2023-11, all-WIP).
