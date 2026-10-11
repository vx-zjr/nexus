---
description: 按 AGENTS.md 的研究流程补全/更新一个人物、家族或机构的档案
argument-hint: <人名/id/家族名>
---
目标：$ARGUMENTS

严格按 AGENTS.md 第 0 节（红线）与第 4 节（AI 代理研究工作流）执行：

1. `npm run ctos -- find "$ARGUMENTS"` 与 `npm run ctos -- show <id>`，弄清现有数据、所在文件、缺口。若不存在，准备新建。
2. 联网检索（维基百科中/英 → 权威媒体 → 官方公报/监管披露 → ICIJ 等调查数据库），重点：
   - 当前职务与状态（是否被调查/落马/离任，写清日期）
   - 家族：父母、配偶（含前配偶）、子女、兄弟姐妹，以及子女配偶及其家族（姻亲是跨家族的桥）
   - 资本：本人及亲属任职/持股的公司、离岸实体
   - 人脉：秘书、提拔者与门生、同学、金主、生意伙伴
   - 本地原始仓库（若已入库）：`npm run ctos -- warehouse search "<英文名/中文名>"` 查 OpenSanctions、ICIJ、FEC 委员会/候选人、国会、法官记录；
     `npm run ctos -- review list icij --entity <id> --status all`、`review list fec --entity <id> --status all` 看离岸/献金候选，
     核实后用 `review decide <source> <id> <ext> same|different|unsure --note "依据"` 裁决（同名不等于同一人）
3. 写 `ids.wikidata` 前必须 `npm run ctos -- wd <名字>` 核实 QID。
4. 只写 `data/curated/`：人物一人一档；家族/派系写 dossier；零散关系写入 `relations/<cn|us|cross>/`。
   每条关系带 `sources` 与 `confidence`；传闻标 `rumor`；纠正导入层错误用 `retract: true`。
5. `npm run ctos -- validate` 必须 0 错误；然后 `npm run ctos -- build`。
6. 汇报：新增/修改了哪些实体与关系、依据哪些来源、哪些线索尚未证实。
