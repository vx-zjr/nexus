# 原始数据仓库与大体量数据层

NEXUS 采用三层结构，把“原始数据的完整镜像”与“人能读、能改、能溯源的图谱”分开：

```
① 原始仓库  data/warehouse/nexus.duckdb（DuckDB，数十 GB，gitignore，可由连接器重建）
     OpenSanctions 全库 · ICIJ 离岸解密 · FEC 2000–2026 · 国会议员 · 联邦法官 · LittleSis
        │  ctos warehouse ingest <source>
        ▼
   ┌─ 审核队列（review_candidates 表 + data/curated/_matches/*.yaml 裁决）
   │      ctos review gen <source> → 前端“审核”视图 / ctos review decide
   ▼
② 图谱层  data/imports/<layer>/*.json（投影：只取与中美精英相关、经确认的部分）
     us-officials · opensanctions · icij · fec · littlesis · wikidata-xids  （+ curated / wikidata / zhao）
        │  ctos build / ctos serve（编译、合并、评分、布局）
        ▼
③ 前端    核心子图（graph.json，~1.2 万实体）+ 本地 API 按需加载完整图谱（~10 万+ 实体）
```

## 数据源

| 来源 | 仓库表 | 体量 | 许可 | 投影层 |
|---|---|---|---|---|
| [OpenSanctions](https://www.opensanctions.org/datasets/default/)（default 全库，FtM） | `os_entities`、`os_edges` | 2.6 GB → 409 万实体 / 207 万边 | **CC BY-NC 4.0**（非商业、须署名） | `opensanctions` |
| [ICIJ Offshore Leaks](https://offshoreleaks.icij.org/pages/database) | `icij_entities/officers/intermediaries/others/relationships`、视图 `icij_nodes` | 72 MB zip → 约 160 万节点 / 250 万关系 | ODbL 1.0 + CC BY-SA 3.0 | `icij`（仅审核确认的匹配） |
| [FEC 批量数据](https://www.fec.gov/data/browse-data/?tab=bulk-data) 2000–2026 | `fec_cm/cn/ccl/pas2/oth/oppexp/indiv`；派生 `fec_donors`（1452 万捐款人）、`fec_donor_recipients`、`fec_committees` | 23.6 GB zip → 2.85 亿笔个人捐款（2000/2002 无运营支出文件） | 美国政府公共领域；**捐款人信息不得用于募捐或商业目的**（52 U.S.C. §30111(a)(4)） | `fec` |
| [congress-legislators](https://github.com/unitedstates/congress-legislators) | `us_legislators`、`us_executive` | 1.3 万人 | CC0 | `us-officials` |
| [FJC 联邦法官传记目录](https://www.fjc.gov/history/judges) | `fjc_judges/service/education/career` | 4 千人 | 公共领域 | `us-officials` |
| [LittleSis](https://littlesis.org/database/bulk_data) | `ls_entities`、`ls_relationships` | 44 万实体 / 188 万关系 | CC BY-SA 4.0 | `littlesis`（已对照实体的关系） |

州议员与联邦行政任命官员（Plural/Open States、PLUM Book）已由 OpenSanctions 整合去重，经 `opensanctions` 层进入图谱。
地方官员（约 50 万人）只有商业数据库（BallotReady、Ballotpedia 付费版）提供完整覆盖，按“免费可达”原则暂不纳入。

> 投影层 `data/imports/{opensanctions,fec,littlesis,icij,wikidata-xids}/` 不进 git（体量大、许可受限），与仓库一样在本地重建。

## 常用命令

```bash
npm run ctos -- warehouse status                  # 各来源：原始文件、入库版本、表行数
npm run ctos -- warehouse fetch [source…]         # 断点续传下载（LittleSis 需手动，见下）
npm run ctos -- warehouse ingest opensanctions    # 入库（可多个：ingest icij congress fjc）
npm run ctos -- warehouse ingest fec --only cm,cn,ccl,pas2   # FEC 可只导部分文件；--only derived 只重建派生表
npm run ctos -- warehouse search "Li Xiaolin" [--source icij]
npm run ctos -- warehouse sql "SELECT count(*) FROM os_entities" [--json]

npm run ctos -- ingest us-officials | opensanctions | icij | fec | littlesis | wikidata-xids   # 投影到图谱层
npm run ctos -- review gen icij|fec|littlesis     # 生成身份匹配候选
npm run ctos -- review list icij [--q 名字] [--entity id] [--status pending]
npm run ctos -- review decide icij <entity-id> <ext-id> same|different|unsure [--note 说明]
npm run ctos -- review stats
npm run ctos -- serve                              # 本地 API（npm run dev 会自动启动）
```

DuckDB 同一时间只允许一个写进程：入库（`warehouse ingest`、`review gen`）期间，API 的仓库检索与审核接口会暂时不可用。

## 资源护栏（防止整机卡死）

本机曾在构建 FEC 派生表时内存耗尽、整机冻结（无 swap 时系统会抖动而不是及时杀进程）。现在的保护措施：

- **重任务自动进护栏**：`warehouse ingest`、`warehouse sql`、`review gen`、`ingest <connector>` 会在 systemd 用户 cgroup 中重新执行
  （`tools/cli/src/guard.ts`）：内存硬上限默认为总内存的 50%（超出只杀该任务，系统不受影响），禁用 swap，CPU 权重与 nice/ionice 调低。
  没有 systemd-run 时只降优先级。环境变量：`NEXUS_MEM_MAX=24G` 调整上限，`NEXUS_GUARD=0` 关闭（不建议对大任务关闭）。
- **DuckDB 默认值按本机计算**：内存 = 总内存 30%，线程 = CPU 核数一半（2–8），中间结果溢写到 `data/warehouse/tmp/`
  （`NEXUS_DUCKDB_MEMORY`、`NEXUS_DUCKDB_THREADS` 可覆盖）。
- **大表聚合规则**：按分区（如 FEC 按周期）逐段聚合；只用 sum/count/min/max/any_value 等可溢写的聚合；
  不要在上亿行、千万组上用 `approx_top_k`、`list`、`string_agg` 等按组持有大状态的聚合。
- **一次只跑一个重任务**；开始前看一眼 `free -g`。

## 隐私与合规（仓库与图谱的边界）

- **图谱层与精编层**严格执行 AGENTS.md 红线：不出现住址、电话、邮箱、证件号、银行账户、医疗记录、实时位置；不收录未成年人；非公众亲属最小化。
- **原始仓库**是公开数据集的本地镜像，入库时已做如下处理：
  - OpenSanctions：丢弃 Address/Identification/Passport/BankAccount/CryptoWallet 实体；人物的地址、电话、邮箱、证件号、税号等属性一律剔除。
  - ICIJ：不导入地址节点、注册地址关系、同地址关系与地址列。
  - FEC：按用户决定**全量原样**保留（含捐款人城市/邮编/雇主/职业，这是 FEC 公开数据的原貌）；投影到图谱时只用姓名、金额、接收方、
    周期与雇主/职业摘要，不出现城市/邮编/州。FEC 数据只用于研究，不得用于募捐或任何商业目的。
- 仓库文件位于 `data/warehouse/`，已在 `.gitignore` 中排除，不要提交、不要分发。

## 身份匹配（审核队列）

外部记录与图谱人物的对应关系按以下优先级确定：

1. **外部 ID**：congress-legislators 自带 FEC/OpenSecrets/Wikidata/Bioguide ID；`wikidata-xids` 从 Wikidata 拉取
   OpenSanctions（P10632）、ICIJ（P10083）、LittleSis（P3388/P3393）、OpenSecrets（P2686/P4691）、FEC（P1839/P7057）、
   国会传记（P1157）、中国政治精英数据库 CPED（P5142）。编译器按相同外部 ID 自动合并实体；ICIJ/FEC 投影把这些对照视为“已确认”。
2. **名字分块 + nomenklatura 打分**：`review gen` 把图谱人物（中英文名、别名、中文名的拼音）与外部记录归一成
   “姓|名”两段式键（顺序、空格、连字符、逗号无关），同键者成为候选；再用 OpenSanctions 的 nomenklatura `logic-v2` 算法打分，
   结合国家相符度、歧义度（同键记录数 × 同键实体数）、中间名首字母冲突、中文原名完全一致等给出排序分 `rank`。
3. **人工/AI 裁决**：在前端“审核”视图（或 `ctos review decide`）逐条判断，写入 `data/curated/_matches/<source>.yaml`：
   `same`（同一人，会被投影）、`different`、`unsure`。该文件属于精编层，进 git，可手工修改。
   **同名不等于同一人**：结合国家/地区、出生年份、公司注册时间与任职经历是否吻合、同一公司的其他股东/董事是否为其亲属来判断；证据不足选 `unsure`。
4. **投影**：`ctos ingest icij` / `ctos ingest fec`（或在审核视图点“投影进图谱”），只接入已确认的匹配。

Python 环境（nomenklatura）：

```bash
python3 -m venv tools/py/.venv && tools/py/.venv/bin/pip install -r tools/py/requirements.txt
```

缺少该环境时 `review gen` 仍可运行，只是没有 nomenklatura 分数（排序只用启发式）。

## LittleSis 手动下载

批量文件是 JSON:API 风格的数组（`{type, id, attributes:{…}}`），入库时展开为带类型的列；实体自带的 `qid` 很少（十余个），
与图谱的对照主要靠 Wikidata 的 LittleSis ID（P3388/P3393，约 2100 个）与审核队列。更新时重新下载即可。

LittleSis 的批量下载页有反爬验证，需在浏览器中手动下载：

1. 用浏览器打开 <https://littlesis.org/database/bulk_data>；
2. 下载页面上的实体（entities）与关系（relationships）批量文件（`.json.gz`），**不要解压**；
3. 放入 `data/warehouse/inbox/littlesis/`，然后运行 `npm run ctos -- warehouse ingest littlesis`。

## 规模与性能

- 完整图谱约 14.7 万实体 / 25.7 万关系，编译约 18 秒，峰值内存约 1.8 GB。
- 浏览器只加载核心子图：出现在非 bulk 层（精编、Wikidata、zhao、ICIJ、跨库 ID）的实体，或 `tier ≤ 3`，或属于某个档案；
  全局布局只对核心子图计算（坐标缓存 `.cache/layout.json`）。
- 其余实体由本地 API（`ctos serve`）按需返回：选中、聚焦关系网、家族树、档案、路径分析时自动拉取并合并，新节点放在邻居附近。
- 静态部署（无 API）时前端退化为只用 `graph.json` 的核心子图模式。
