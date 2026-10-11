# AGENTS.md — NEXUS 人脉情报中心

> 本文件是本项目的“操作系统”。任何 AI 代理（Claude Code、Codex、Cursor、Gemini…）或人类协作者，
> 在读写本仓库前都必须先读完本文件。所有约定以本文件为准；修改约定时同步更新本文件。

## 0. 使命与红线

**使命**：用公开、合法的信息，持续构建并维护一张“权力关系图谱”——中美两国在政治、商业、军事、金融、科技、传媒等领域
具有重要影响力的人物，以及他们的家族、姻亲、门生、秘书、白手套、关联公司之间的关系；做到**每条信息可溯源、可核验、可迭代**。

**红线（违反即视为数据错误，`validate` 会报错）**：

1. **只用公开合法来源**：维基百科/Wikidata、权威媒体报道、官方网站与公报、监管披露（SEC/港交所/巨潮/国家企业信用信息公示系统）、
   国会财产申报、FEC 政治献金、法院文书、ICIJ 等公开解密数据库、正式出版书籍、本人公开的社交媒体。
   不使用、不寻求任何黑客、撞库、社工、付费黑产、泄露的个人隐私数据。
2. **不收录隐私字段**：住址、电话、邮箱、身份证/护照/社保号、车牌、银行账户、医疗记录、实时位置。字段名黑名单见
   `packages/core/src/vocab.ts → FORBIDDEN_FIELDS`。
3. **不收录未成年人**：在世且未满 18 岁的人一律不收（编译器会自动剔除并报错）。
4. **非公众亲属最小化**：权贵的非公众亲属只记录“与谁是什么关系 + 公开报道过的商业/职务角色”，不写私生活细节。
5. **区分事实与传闻**：每条关系必须带 `confidence`。传闻可以记录（它是线索），但必须标 `rumor`，UI 会以虚线显示。
6. **同名不等于同一人**：外部记录（离岸公司、政治献金等）与图谱人物的对应，只有在外部 ID 对照（Wikidata 等）或经审核确认
   （`data/curated/_matches/`）后才能进入图谱；拿不准一律标 `unsure`，不得凭名字相同直接关联。

**红线的适用范围**：以上规则约束图谱层（`data/curated/`、`data/imports/`）与界面。`data/warehouse/` 是公开数据集的本地原始镜像
（不进 git、不分发），入库时已剔除 OpenSanctions/ICIJ 的地址与证件等字段；FEC 按用户决定全量原样保留，但**FEC 捐款人信息依法不得用于募捐或任何商业目的**，
投影进图谱时不出现城市/邮编/州。详见 `docs/warehouse.md`。

## 1. 快速开始

```bash
npm install
npm run ctos -- build          # 编译 data/ → apps/web/public/data/graph.json（核心子图）
npm run dev                    # 启动界面 http://127.0.0.1:5317，并自动拉起本地 API :5318（完整图谱按需加载；data/ 变动自动重编译并推送）
npm run ctos -- serve          # 单独启动本地 API
npm run ctos -- help           # CLI 全部命令

# 原始数据仓库（可选，数十 GB；详见 docs/warehouse.md）
python3 -m venv tools/py/.venv && tools/py/.venv/bin/pip install -r tools/py/requirements.txt   # nomenklatura 匹配打分
npm run ctos -- warehouse fetch && npm run ctos -- warehouse ingest all
npm run ctos -- ingest us-officials && npm run ctos -- ingest opensanctions && npm run ctos -- ingest wikidata-xids
```

## 2. 仓库结构（模块化，可单独拆用）

```
AGENTS.md                ← 你正在读的驱动文件（CLAUDE.md 引用它）
data/                    ← 知识库本体：纯 YAML，git 可 diff，人和 AI 都能直接编辑
  layers.yaml            ← 数据层配置（优先级/许可）
  curated/               ← ★ 精编层：唯一允许手工/AI 编辑的地方（优先级最高）
    persons/<id>.yaml    ←   一人一档
    orgs/*.yaml          ←   机构（可一机构一档，也可按主题打包）
    dossiers/<id>.yaml   ←   档案：家族 / 派系 / 关系网 / 机构班子 / 案件（可内嵌 relations）
    relations/{cn,us,cross}/*.yaml ← 按主题组织的关系
    _matches/<source>.yaml ← 身份匹配裁决（外部记录 ↔ 图谱实体；审核视图/`ctos review decide` 写入，可手改）
  imports/<connector>/   ← 连接器自动生成（wikidata / zhao / us-officials / opensanctions / icij / fec / littlesis / wikidata-xids），禁止手改
                            大体量层输出 JSON 分片（entities-NNN.json / relations-NNN.json）
  warehouse/             ← 原始数据仓库（DuckDB + 原始下载，gitignore，可重建；见 docs/warehouse.md）
packages/core/           ← 内核（纯 TS，无 UI）：schema(zod)、词表、编译合并、图算法、子图/补丁、导出器
tools/cli/               ← CLI：校验/编译/查询/采集/导出；connectors/ 数据源连接器；warehouse/ 原始仓库；
                            review/ 身份匹配审核队列；server.ts 本地 API（ctos serve）
tools/py/                ← Python 工具（nomenklatura 实体匹配打分）
apps/web/                ← React + Vite + TS 可视化界面（sigma.js 网络图、dagre 族谱、路径分析、时间线、数据中心、审核）
docs/                    ← 方法论、数据源目录、数据模式、架构说明
```

依赖方向：`apps/web → @nexus/core ← tools/cli`。core 不依赖任何 UI/文件系统，可被其他项目直接复用。

## 3. 数据模型速览（详见 docs/schema.md）

**实体（entity）**：`type: person | org`。id 用小写 kebab-case：
- 中国人：姓-名拼音 `xi-jinping`、复姓 `ouyang-zhongshi`；重名追加出生年 `wang-jun-1941`
- 外国人：英文名 slug `donald-trump`、`robert-f-kennedy-jr`
- 机构：英文或拼音 slug `ccp-politburo`、`wan-da-ji-tuan`

```yaml
# data/curated/persons/li-qiang.yaml
id: li-qiang
type: person
name: 李强                         # 主显示名（中国人用中文，外国人用英文）
names: { zh: 李强, en: Li Qiang }
gender: M
born: 1959-07                      # YYYY / YYYY-MM / YYYY-MM-DD
country: [CN]
sectors: [politics]                # 见 vocab.ts → SECTORS
tier: 1                            # 1 最高 … 5 最低（影响默认显示与评分）
status: active                     # active|retired|deceased|investigated|detained|purged|exiled|unknown
summary: 国务院总理（2023–）……
positions:                         # 带 org 的职务会自动生成 position 关系
  - { title: 国务院总理, org: state-council-prc, from: 2023-03, current: true }
  - { title: 浙江省委秘书长, from: 2004-11, to: 2007-08 }
ids: { wikidata: Q... }            # 外部 ID：用于跨层自动合并。QID 必须用 `ctos wd` 核实，严禁猜测
sources:
  - { url: https://..., title: ..., publisher: ..., date: 2026-04-03 }
```

**关系（relation）**：有向关系一律读作“from 是 to 的 …”。类型词表见 `packages/core/src/vocab.ts → RELATION_TYPES`（`npm run ctos -- vocab`）。

```yaml
relations:
  - [xi-zhongxun, parent, xi-jinping, 次子]                 # 简写：[from, type, to, label?, confidence?]
  - { from: deng-jiagui, to: excellence-effort-property-development, type: owner, label: 50%,
      confidence: reported, sources: [https://www.icij.org/...] }
  - { from: xi-jinping, to: ke-lingling, type: spouse, retract: true, note: 应为前妻 }   # 撤回导入层的错误关系
```

关键方向约定：`parent`(父母→子女)、`patron`(提拔者→门生)、`aide`(秘书→上司)、`position/member/founder/owner/board/alumni/donor/investor`(人→机构/对象)、
`parent-org`(母公司→子公司)、`legal`(发起方→被调查/起诉方)。

**档案（dossier）**：zhao 方法论的“一族一档”推广而来。`kind: family|faction|network|institution|case|watchlist`；
`core` = 血亲/核心成员，`outer` = 姻亲、白手套、关联公司；可内嵌 `relations`，文件级 `sources/confidence` 作为默认值被内部关系继承。

**可信度**：`confirmed`(官方/一手或≥2 家权威媒体) > `reported`(单一权威来源/维基百科) > `alleged`(指控) > `disputed`(矛盾) > `rumor`(传闻)。

**数据层合并**：同一实体可出现在多个层（按 id 或相同外部 ID 合并）。标量字段取高优先级层；数组取并集。
层配置见 `data/layers.yaml`；标 `bulk: true` 的大体量层（us-officials、opensanctions、fec、littlesis、wikidata-xids）只有 tier ≤ 3 的实体进入浏览器默认加载的核心子图，
其余经本地 API 按需加载。常用外部 ID 键：`wikidata`、`opensanctions`、`icij`、`littlesis`、`opensecrets`、`fec`（候选人）、`fec_committee`、
`fec_donor`、`bioguide`、`fjc`、`cped`、`zhao`。
**纠错永远写在 curated 层**：覆盖字段即可；要删除导入层的错误关系用 `retract: true`。
**身份裁决**：`validate` 报 `possible-duplicate` 时，在 `data/curated/identity.yaml` 中用 `sameAs: <另一 id>` 声明同一人（强制合并），
或用 `distinctFrom: [<id>]` 声明不同人（消除误报）。

## 4. AI 代理研究工作流（必须遵守）

每次接到“补充/更新某人/某家族/某机构”的任务，按以下循环执行（Claude Code 中可直接用 `/research <名字>`；定期维护用 `/refresh`，定义见 `.claude/commands/`）：

1. **定位**：`npm run ctos -- find <中文/英文/拼音>`，确认实体是否存在、id 是什么、定义在哪些文件。
   `npm run ctos -- show <id>` 看现有档案、关系与来源。没有就准备新建（`npm run ctos -- new person <id> --name ...`）。
2. **领任务**：不知道先做什么时，`npm run ctos -- todo` 给出“影响力 × 资料缺口”排序的待办。
3. **检索**：优先级 ① 维基百科（中/英）与 Wikidata ② 路透/美联/彭博/纽时/华日/FT/财新/SCMP 等 ③ 官方公报（新华社、中纪委、国防部、白宫、国会、SEC）
   ④ 监管披露与工商登记 ⑤ ICIJ 等公开调查数据库 ⑥ 书籍与学术研究（如 Brookings 李成的中共领导人研究）。
   本地原始仓库可先查：`npm run ctos -- warehouse search <名字>`（OpenSanctions/ICIJ/FEC 委员会与候选人/国会/法官/LittleSis），
   个人捐款明细加 `--source fec-indiv`；`npm run ctos -- review list icij --entity <id>` 看该人的离岸记录候选。
   时效性强的信息（任免、落马、婚姻、持股）必须查最新报道并写明日期。
4. **核验**：重要关系尽量找到 ≥2 个独立来源再标 `confirmed`；单一来源标 `reported`；网络传闻标 `rumor` 并在 note 说明出处。
   写 `ids.wikidata` 前用 `npm run ctos -- wd <名字>` 核实 QID。
5. **落笔**：只写 `data/curated/`。人物一人一档；家族/派系写成 dossier；零散关系写进 `relations/<cn|us|cross>/<主题>.yaml`。
   状态变化（被调查/落马/去世/离任）要同时更新 `status`、相关 `positions[].to` 与 summary，并附来源。
6. **校验**：`npm run ctos -- validate` 必须 0 错误；警告尽量清零。
7. **编译**：`npm run ctos -- build`（开发服务器运行时会自动完成）。
8. **汇报**：说明新增/修改了哪些实体与关系、依据哪些来源、还有哪些未能证实的线索。

**身份匹配审核**（外部记录 → 图谱）：`npm run ctos -- review gen icij|fec|littlesis` 生成候选 → 前端“审核”视图（或 `review list/decide`）逐条裁决
→ `npm run ctos -- ingest icij|fec|littlesis` 投影。裁决标准：国家/地区、出生年份、公司注册时间与任职经历、同公司其他股东/董事是否为其亲属；
AI 代理裁决时须在 `--note` 写明依据，证据不足用 `unsure`。

批量扩充覆盖面（而非逐个精编）时使用连接器：
- `npm run ctos -- ingest wikidata --preset all`（或指定预设，见 `tools/cli/src/connectors/wikidata.ts → PRESETS`）
- `npm run ctos -- ingest wikidata --qids Q123,Q456 --tier 2 --sector business`（把指定人物及其一度亲属拉进来）
- `npm run ctos -- ingest wikidata --wp-category "zh:中国共产党第二十届中央委员会委员" --tier 3 --sector politics --country CN`
  （Wikidata 缺少成员关系的群体：先取维基百科分类成员 → 解析 QID → 走同一管线；可重复传多个 `--wp-category`）
- `npm run ctos -- ingest zhao`（编程随想《太子党关系网络》，GPL-3.0）
- `npm run ctos -- ingest wikidata-xids`（为所有带 QID 的实体补齐跨库外部 ID；新增 Wikidata 实体后重跑）
- 仓库投影（需先 `warehouse ingest`）：`ingest us-officials`（国会/总统/联邦法官）、`ingest opensanctions`（中美政要、亲属关联人、制裁）、
  `ingest icij`（已确认的离岸记录）、`ingest fec`（PAC→候选人、超级捐款人、已确认捐款人）、`ingest littlesis`（已对照实体的美国政商关系）
- Wikidata 查询结果缓存在 `.cache/wikidata-queries/`（7 天），中断后直接重跑即可断点续传；`--fresh` 强制刷新。

## 5. 研究方法论要点（来自 zhao 项目并加以改进，详见 docs/methodology.md）

- **圈定对象**：按“代际/职级/财富”分层列出要覆盖的人（zhao 用“第 1–5 代高官、开国将帅”；本项目用 Wikidata 预设 + tier）。
- **一人一档**：常用名、曾用名、性别、生卒、简述、链接。**改进**：结构化履历（带时间）、状态、外部 ID、逐条来源。
- **一族一档**：以家族中最显赫者命名，`core`=血亲，`outer`=姻亲/关联公司；关系写成三元组。**改进**：关系类型受控、带方向、时间与可信度。
- **以姻亲与资本为桥**：家族之间、家族与公司之间的连接（联姻、早期股东、离岸公司、秘书）是最有情报价值的边，优先挖掘。
- **持续复核**：换届、全会、大选、财报季、重大调查报道发布后，复查相关人物状态。

## 6. 扩展与对接

| 想做的事 | 改哪里 |
|---|---|
| 新增关系类型/领域/状态 | `packages/core/src/vocab.ts`（UI、校验、导出自动适配） |
| 新增数据源 | `tools/cli/src/connectors/<name>.ts` 实现 `Connector`，在 `connectors/index.ts` 登记，`data/layers.yaml` 加一层 |
| 新增大体量数据源 | `tools/cli/src/warehouse/sources.ts` 加 `WarehouseSource`（下载+入库）→ 投影连接器（`shards.ts` 输出 JSON 分片，层标 `bulk: true`）→ 需审核身份时在 `review/sources.ts` 加 `ReviewSource`；见 `docs/warehouse.md` |
| 新增 API 接口 | `tools/cli/src/server.ts`（前端客户端在 `apps/web/src/lib/api.ts`） |
| 新增导出格式 | `packages/core/src/export/index.ts` |
| 新增可视化视图 | `apps/web/src/views/*.tsx`，在 `App.tsx` 与 `TopBar.tsx` 注册 |
| 在其他项目中使用数据 | 读 `apps/web/public/data/graph.json`（类型见 `packages/core/src/types.ts`），或 `npm run ctos -- export all` 导出 CSV / GraphML / GEXF(Gephi) / Cypher(Neo4j) / DOT(Graphviz) / JSONL(RAG) / Markdown / FtM |
| 对接调查/合规生态 | `npm run ctos -- export ftm [--min-confidence reported]` → FollowTheMoney 实体流，可 `ftm validate`、导入 OCCRP Aleph（`alephclient write-entities`）、与 OpenSanctions 比对；映射规则见 `packages/core/src/export/ftm.ts` 文件头 |
| 在其他 TS 项目中复用算法 | `import { compile, NexusIndex } from '@nexus/core'` |

## 7. 代码约定

- TypeScript strict；ESM；包内用相对路径 + `.ts` 扩展名导入。改动后运行 `npm run typecheck`。
- `@nexus/core` 必须保持纯函数、无 Node/DOM 依赖（`util.ts` 的 pinyin 除外，它同构可用）。
- UI 风格：深色 HUD（致敬 ctOS），颜色/语义来自 vocab；新组件复用 `styles/index.css` 中的 `panel / btn / chip / hud-title`。
- 注释与文档用中文；标识符用英文。
- 不要提交 `apps/web/public/data/`、`exports/`、`.cache/`、`data/warehouse/`、`.env`、`tools/py/.venv/`（均可再生或含密钥）；
  仓库投影层 `data/imports/{opensanctions,fec,littlesis,icij,wikidata-xids}/` 体量大且许可受限，也不进 git（用 `ingest` 重建）。
  进 git 的数据只有 `curated/` 与 `imports/{wikidata,zhao,us-officials}/`。
- 密钥（如 `FEC_API_KEY`）只放 `.env`，不得写进代码、文档或日志。
- **资源护栏（本机无 swap，曾因内存耗尽整机卡死）**：重任务（`warehouse ingest/sql`、`review gen`、`ingest`）由 `tools/cli/src/guard.ts`
  自动放进 systemd cgroup（内存上限默认 50%、低优先级），不要用 `NEXUS_GUARD=0` 跑大任务；一次只跑一个重任务，开始前看 `free -g`；
  DuckDB 大表聚合按分区逐段进行，只用可溢写的聚合（sum/count/min/max/any_value），禁止在上亿行上用 approx_top_k/list/string_agg。
  长时间任务放后台运行并定期检查内存，不要阻塞等待。
- 前端视图使用 `useNexus` 中的 `index`（已加载的子图）；需要完整图谱的数据时调用 `lib/api.ts`（`ensureEntity/ensureEgo/ensureFamily/remotePaths…`），
  补丁经 `mergePatch` 合并后视图自动更新；API 不可用时必须能退化为静态模式。

## 8. 常见任务配方

- **记录一次落马**：在 `persons/<id>.yaml` 设 `status: investigated|purged|detained`，把相关 `positions[].to` 设为免职月份，
  summary 写清时间线，sources 附官方通报与权威报道；若涉及上级/机构，在相关 dossier 的 relations 加 `legal` 边（from = 中纪委/军委纪委/司法部等）。
- **新增一个家族**：`dossiers/family-<head-id>.yaml`，`kind: family`、`head`、`core/outer`、`relations`，文件级 `sources` 写主来源。
  新出现的人物先建 `persons/<id>.yaml`。
- **纠正导入层错误**：在 curated 层重写该字段；错误关系用 `retract: true` 撤回，并加正确关系。
- **跨国关联**：写进 `dossiers/us-china-bridges.yaml` 或 `relations/cross/*.yaml`。
- **确认一条离岸/献金记录**：`npm run ctos -- review list icij --q <名字>` → 核实 → `npm run ctos -- review decide icij <entity-id> <ext-id> same --note "依据…"`
  → `npm run ctos -- ingest icij`。若是 ICIJ 已公开报道的知名案例，可同时在精编层写一条带报道来源的 `owner` 关系（confidence 按报道质量）。
