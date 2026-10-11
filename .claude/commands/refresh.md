---
description: 定期刷新：按观察名单复核时效信息，并重跑数据连接器
---
1. 读 `data/curated/dossiers/watchlist-*.yaml`，逐项联网核实其中的事件是否已发生、结果如何；把结果写回相关人物/档案（含日期与来源），并更新观察名单本身（移除已完成项、加入新事件）。
2. `npm run ctos -- todo --limit 30`：挑选影响力最高、资料最薄弱的 5–10 人，按 /research 的流程补全。
3. 视需要重跑连接器（会使用 7 天查询缓存）：
   `npm run ctos -- ingest wikidata --refresh`、`npm run ctos -- ingest wikidata-xids`
   原始仓库按需刷新（OpenSanctions 每日更新、FEC 每周更新）：`npm run ctos -- warehouse fetch opensanctions && npm run ctos -- warehouse ingest opensanctions`
   → `npm run ctos -- ingest opensanctions`；审核新候选：`npm run ctos -- review gen icij` 后在“审核”视图处理，再 `ingest icij`。
4. `npm run ctos -- validate`（0 错误）→ `npm run ctos -- build`。
5. 汇报本轮更新摘要（新增实体/关系数量、重要人事变动、仍待核实的线索）。
