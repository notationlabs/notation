# Dashboard resource tabs + grouping

**Idea:** Improve the `@notation/dashboard` UI so resources render grouped by resource group,
with per-resource tabs (details, useful links) and an active-tab state.

Minimal shape (relative to main):

- `packages/dashboard/src/app.tsx` — render resources aggregated by resource group; add
  resource tabs with active-tab handling and a "useful links" tab.
- Supporting metadata surfaced from `packages/core/src/orchestrator/resource-group.ts` and
  `resource.ts` (group identity + links).

**Source branch (archaeology):** `dashboard-ui` (~2023-12). UI is stale but the grouping/tabs
UX is the reusable idea.
