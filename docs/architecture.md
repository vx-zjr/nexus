# 架构

```
 data/warehouse/nexus.duckdb（原始仓库：OpenSanctions/ICIJ/FEC/国会/法官/LittleSis，见 docs/warehouse.md）
        │ 投影连接器（us-officials / opensanctions / icij / fec）   ▲ 审核队列 review_candidates
        ▼                                                         │ （nomenklatura 打分，裁决写入 curated/_matches/）
            ┌──────────────── data/（知识库）─────────────────────────────┐
            │ curated/  (精编, priority 100)                               │
            │ imports/us-officials (60, bulk)  wikidata (50)  wikidata-xids (49) │
            │ imports/opensanctions (45, bulk)  fec (40, bulk)  icij (35)  zhao (30) │
            └───────────────┬────────────────────────────────────────────┘
                            │ loadDocs()（YAML / JSON 分片）
                            ▼
 tools/cli  ── compile() ── @nexus/core
   │            │  1 解析/校验(zod) 2 身份合并(id/外部ID 并查集) 3 派生关系(职务/教育/母公司)
   │            │  4 隐私&未成年人策略 5 关系归一/去重/撤回 6 档案 7 PageRank+Louvain
   │            ▼
   │      GraphData（完整图谱）── coreIds()/subsetGraph() ── 核心子图 ── layoutGraph()（ForceAtlas2，坐标缓存）
   │            │
   ├── serve → 本地 API :5318（内存持有完整图谱；/api/core、search、entity、ego、family、dossier、path、
   │            warehouse/search、review；监听 data/ 自动重编译并经 SSE 推送）
   ├── build → apps/web/public/data/graph.json（核心子图，静态部署/离线模式用）
   ├── export → exports/{csv,graphml,gexf,cypher,dot,jsonl,markdown,ftm}
   └── find/show/path/dossier/todo/validate/review/warehouse（给人和 AI 代理）

 apps/web（React）── 启动时取核心子图 → 交互时按需拉取补丁（GraphPatch）→ mergePatch() 合并进本地图
```

## 包

| 包 | 职责 | 依赖 |
|---|---|---|
| `@nexus/core` | 词表、输入模式、编译器、图查询（`NexusIndex`）、子图/补丁（`coreIds`、`subsetGraph`、`mergePatch`）、布局、指标、导出器 | zod、graphology（及算法包）、pinyin-pro |
| `@nexus/cli` | 文件读写、命令行、连接器、ID 分配器（跨层复用 id，防止同名误合并）、原始仓库（`warehouse/`）、审核队列（`review/`）、本地 API（`server.ts`） | core、yaml、@duckdb/node-api |
| `@nexus/web` | 可视化界面；开发模式下 Vite 插件自动拉起本地 API 并代理 `/api`（`NEXUS_NO_API=1` 时退回“监听 data/ → ctos build”模式） | core、react、sigma、graphology、dagre、zustand、tailwind |
| `tools/py` | nomenklatura（OpenSanctions 的实体匹配库）打分脚本 `score_pairs.py` | nomenklatura、followthemoney |

## 关键设计

- **身份合并**：同一个人可能同时来自 zhao（`ids.zhao`）、Wikidata（`ids.wikidata`）与精编层。编译器用并查集按“相同 id 或相同外部 ID”合并，
  规范 id 取最高优先级层的 id；导入时 `IdAllocator` 先按外部 ID、再按“姓名 + 出生年份（±1）”匹配既有实体，避免同名不同人被合并。
- **派生关系**：`positions[].org` → `position`；`education[]` → `alumni`；`org.parent` → `parent-org`。UI 可一键隐藏派生边。
- **撤回**：精编层写 `retract: true` 可删除低优先级层中的错误关系（例如把 zhao 的“妻”纠正为“前妻”）。
- **评分**：`score = 0.55 × tier 分 + 0.45 × PageRank 百分位`；教育/成员等弱关系在 PageRank 中降权；路径搜索对超级枢纽机构加罚。
- **稳定布局**：全局 ForceAtlas2 坐标缓存，新增节点放在已有邻居质心附近做增量迭代，保持“地图记忆”。
- **大体量层（bulk）**：`layers.yaml` 中标 `bulk: true` 的层（us-officials、opensanctions、fec）只有 tier ≤ 3 的实体进入核心子图；
  完整图谱由 `ctos serve` 在内存中持有，前端选中/聚焦/家族/路径时按需拉取。`NetworkView` 以可见节点与关系的签名决定是否重建渲染器，避免补丁合并导致镜头跳动。
- **职位节点**：OpenSanctions 的任职只有职位名，连接器把每个职位落成一个机构节点（重要职位直接挂到精编层机构，如全国政协、美国参议院），
  使只存在于该层的人物也能经由“同一职位”连进图谱。
- **可移植**：`graph.json` 是自描述的（`meta.schemaVersion`），外部系统只需依赖 `types.ts` 中的接口。
- **标准互通**：FollowTheMoney 导出器把实体映射为 Person / Company / PublicBody / Organization，把关系映射为 Family、Associate、
  Position+Occupancy、Employment、Directorship、Membership、Ownership、Payment、Representation、Sanction、UnknownLink；
  已用官方 `followthemoney` 4.11 校验（0 错误）。可信度写入边实体的 description，`--min-confidence` 可过滤。
