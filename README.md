# NEXUS · 人脉情报中心

一个**个人用的权力关系情报中心**（视觉风格致敬《看门狗》ctOS）：把中美两国政治、商业、军事、金融、科技、传媒等领域的权贵人物，
以及他们的家族、姻亲、门生、秘书、关联公司，用**公开合法来源**整理成一张可交互、可溯源、可持续迭代的关系图谱。

- **AGENTS.md 驱动**：项目约定、数据红线、AI 研究流程全部写在 [AGENTS.md](AGENTS.md)，任何 AI 代理都能接手迭代。
- **数据即文件**：知识库是 `data/` 下的纯 YAML（一人一档、一族一档），git 可 diff，人和 AI 都能直接读写。
- **多层合并**：精编层（人工/AI 研究，带来源）覆盖自动导入层（Wikidata、编程随想 zhao 项目、OpenSanctions、美国官员、ICIJ、FEC）。
- **原始数据仓库**：OpenSanctions 全库、ICIJ 离岸解密、FEC 2000–2026 政治献金、国会议员、联邦法官、LittleSis 全量入本地 DuckDB，
  只把与中美精英相关、经确认的部分投影进图谱；外部记录与人物的身份对应走“名字分块 + nomenklatura 打分 + 人工审核”。见 [docs/warehouse.md](docs/warehouse.md)。
  重任务自动在内存受限的 cgroup 中低优先级运行，避免拖垮整机。
- **可视化、可交互**：React + Vite + TS；WebGL 关系网络、族谱树、六度关系路径、人物档案（PROFILER）、数据质量中心。
- **模块化、易对接**：`@nexus/core`（纯 TS 内核）、`tools/cli`（命令行与连接器）、`apps/web`（界面）；一键导出 CSV / GraphML / GEXF / Neo4j / Graphviz / JSONL / Markdown / **FollowTheMoney**（OCCRP Aleph、OpenSanctions 使用的调查数据标准）。

## 当前数据（2026-10-11）

| 数据层 | 实体 | 关系 | 说明 |
|---|---|---|---|
| curated 精编层 | 290 | 637 | 中共二十届政治局/军委（含 2025–2026 落马）、特朗普第二任期内阁（含 2026 年人事变动）、20+ 个家族/派系/案件/跨国关系网档案，每条附来源 |
| wikidata | 6,923 | 10,894 | 中美政界与商界精英 + 一度亲属 |
| zhao | 871 | 787 | 编程随想《太子党关系网络》165 个家族 |
| us-officials | 5,903 | 11,291 | 1970 年后国会议员、历任总统/副总统、联邦法官（任命关系） |
| opensanctions | 99,329 | 65,235 | 中美（含港澳台）政要、亲属关联人、被制裁/反制裁人物与机构、职位节点 |
| fec | 9,700 | 81,435 | PAC→候选人（47k）、超级捐款人（1,368 人）个人捐款（34k） |
| littlesis | 32,082 | 48,794 | 2,130 个已对照实体的美国政商关系（任职、董事、家族、持股、游说…） |
| icij | 375 | 471 | 54 个 Wikidata 已对照人物的离岸公司、中介与共同高管 |
| wikidata-xids | 35,353 | — | 跨库外部 ID 标注层（OpenSanctions/ICIJ/LittleSis/OpenSecrets/FEC/国会/CPED） |
| **合并后** | **146,767** | **257,109** | 人物 105,835 / 机构 40,932；185 个档案，24.9 万条来源，0 错误；浏览器核心子图 1.26 万实体 |

待审核的身份匹配候选：ICIJ 离岸 21,618 条、FEC 捐款人 16,530 条、LittleSis 11,536 条（界面“审核”视图）。

> **Git 仓库里的数据**：只包含 curated、wikidata、zhao、us-officials 四层（约 1.27 万实体）。opensanctions、fec、littlesis、icij、wikidata-xids
> 由本地原始仓库投影生成，体量大且许可受限（CC BY-NC / CC BY-SA / ODbL / FEC 使用限制），不随仓库分发；按下方“原始数据仓库”步骤在本地重建。

## 快速开始

```bash
npm install
npm run ctos -- build      # 编译数据（核心子图 → graph.json）
npm run dev                # http://127.0.0.1:5317（自动启动本地 API :5318，完整图谱按需加载）
```

大体量投影层（opensanctions / fec / littlesis / wikidata-xids）不进 git，克隆后从 Release 数据快照恢复（约 18 MB）：

```bash
gh release download data-2026-10-11 -p 'nexus-imports-*.tar.gz' && tar -xzf nexus-imports-2026-10-11.tar.gz && rm nexus-imports-2026-10-11.tar.gz
```

也可以自己从原始数据重建。原始数据仓库（可选，约 27 GB 下载、50 GB 磁盘）：

```bash
python3 -m venv tools/py/.venv && tools/py/.venv/bin/pip install -r tools/py/requirements.txt
npm run ctos -- warehouse fetch            # 断点续传下载（LittleSis 需手动，见 docs/warehouse.md）
npm run ctos -- warehouse ingest all       # 入库 DuckDB
npm run ctos -- ingest us-officials && npm run ctos -- ingest opensanctions && npm run ctos -- ingest wikidata-xids
npm run ctos -- review gen icij            # 离岸记录候选 → 界面“审核”视图裁决 → npm run ctos -- ingest icij
npm run ctos -- ingest fec                 # PAC→候选人、超级捐款人
npm run ctos -- ingest littlesis           # 已对照实体的美国政商关系（LittleSis 需手动下载）
```

常用命令（完整列表：`npm run ctos -- help`）：

```bash
npm run ctos -- find 习近平            # 搜索（中文/英文/拼音/首字母均可，如 xjp）
npm run ctos -- show li-qiang          # 人物档案（Markdown）
npm run ctos -- path elon-musk li-qiang  # 两人之间的关系路径
npm run ctos -- dossier family-xi-jinping
npm run ctos -- todo                   # 研究待办：影响力高但资料薄弱的人物
npm run ctos -- validate               # 校验（模式、引用、隐私红线、未成年人）
npm run ctos -- ingest wikidata --preset all   # 批量采集中美权贵及其亲属
npm run ctos -- ingest zhao            # 导入《太子党关系网络》
npm run ctos -- export all             # 导出到 exports/
npm run ctos -- export ftm --min-confidence reported   # FollowTheMoney 实体流（可导入 Aleph）
npm run ctos -- wd "Kevin Warsh"       # 查 Wikidata QID
npm run ctos -- warehouse search "Li Xiaolin"   # 在原始仓库中检索（OpenSanctions/ICIJ/FEC/国会/法官）
npm run ctos -- review list icij --q 李小琳      # 查看身份匹配候选
npm run ctos -- serve                  # 单独启动本地 API
```

## 界面

| 视图 | 功能 |
|---|---|
| 关系网络 | 全局图（按影响力取前 N 个节点）、双击聚焦 1–3 跳关系网、档案/路径子图；按国家/领域/关系类别/可信度/数据层筛选 |
| 家族档案 | 族谱式分层布局（婚姻节点、同胞对齐），姻亲/秘书/持股以虚线叠加；左侧为全部家族/派系/案件档案 |
| 关系路径 | 加权最短路径（家族最近、校友最远），多条备选路径，每跳显示关系、时间、可信度、来源 |
| 时间线 | 任免、立案/开除、任命、婚姻、持股、捐款等带日期事实的倒序事件流，可按国家/类别/年份/关键词筛选 |
| 数据中心 | 规模统计、数据层、原始仓库状态、校验问题、研究待办、影响力榜 |
| 审核 | 外部记录（ICIJ 离岸、FEC 捐款人）与图谱人物的匹配候选：排序分、国家/中文名一致性、关联公司/捐款对象上下文，一键裁决并投影进图谱 |
| PROFILER | 身份卡、履历时间线、按类别分组的关系（可信度+来源）、所属档案、外部记录（跨库 ID 直达链接、原始仓库检索、待审候选）、数据文件路径、一键复制“AI 研究指令” |

快捷键：`/` 搜索，`1–6` 切换视图，`Esc` 取消选中。右上角绿点 = 本地 API 在线（完整图谱）；琥珀色 = 静态模式（只有核心子图）。URL 会记录当前视图与选中对象，可收藏/分享。

## 目录

见 [AGENTS.md §2](AGENTS.md#2-仓库结构模块化可单独拆用)。文档：[方法论](docs/methodology.md) · [数据源](docs/sources.md) · [数据模式](docs/schema.md) · [架构](docs/architecture.md) · [连接器](docs/connectors.md) · [原始仓库](docs/warehouse.md)

## 数据与许可

- 代码：个人项目，未附开源许可（如需开源请自行添加 LICENSE）。
- `data/imports/us-officials/` 来自 unitedstates/congress-legislators（CC0）与联邦司法中心（公共领域）。
- `data/imports/zhao/` 派生自 [programthink/zhao](https://github.com/programthink/zhao)，遵循 **GPL-3.0**；如需对外分发包含该层的数据，请遵守 GPL-3.0。
- `data/imports/wikidata/` 来自 Wikidata（CC0）。以下各层不随仓库分发，在本地由原始仓库生成：
  - `wikidata-xids/`：Wikidata（CC0）。
  - `opensanctions/`：来自 OpenSanctions，**CC BY-NC 4.0**：仅限非商业使用，须署名。
  - `icij/`：来自 ICIJ Offshore Leaks Database（ODbL 1.0 / CC BY-SA 3.0），须注明 ICIJ；持有离岸公司本身并不违法。
  - `fec/`：来自 FEC（美国政府公共领域）；**捐款人信息依法不得用于募捐或商业目的**（52 U.S.C. §30111(a)(4)）。
  - `littlesis/`：来自 LittleSis（CC BY-SA 4.0）：须署名，衍生数据须以相同方式共享。
- `data/warehouse/`（原始镜像）不进 git、不分发。
- `data/curated/` 中每条信息都附有来源链接，引用时请保留出处。

本项目只收录公开、合法的信息；不收录住址、电话、证件号等隐私，不收录未成年人。数据中的“传闻/指控”均明确标注，不代表事实认定。
