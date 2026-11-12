---
"@notation/cli": patch
---

`notation watch` now deploys a change that was saved during a deploy that failed. Before, the change was dropped and was not deployed until the next save.
