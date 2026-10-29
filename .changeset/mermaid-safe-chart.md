---
"@notation/core": patch
---

`notation viz` charts now render when resource or group names contain characters Mermaid can't use in IDs, such as an API name with a space or a route with a path parameter like `/todos/{id}`. Previously, such names made the chart fail to parse. Nodes and subgraphs now get IDs from their position in the chart, and their names go in quoted, escaped labels that show the type and ID, such as `Lambda get-todos`. Resources that are in no group are drawn too, outside every subgraph.
