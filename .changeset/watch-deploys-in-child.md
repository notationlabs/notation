---
"@notation/cli": patch
---

`notation watch` runs each deploy in a fresh child process, so its memory no longer grows with every rebuild. `notation deploy` gains `--no-compile` and `--no-drift-detection`.
