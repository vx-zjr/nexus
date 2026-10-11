# 编写数据连接器

连接器把外部数据源转换成 NEXUS 的 YAML，写入 `data/imports/<layer>/`。它们**只写导入层**，永远不碰 `data/curated/`。

## 现有连接器

| id | 数据源 | 说明 |
|---|---|---|
| `wikidata` | Wikidata SPARQL + 维基百科分类 API | 预设圈定（职位/财富）或 `--qids`、`--wp-category` 指定种子 → 抓取身份、职务、亲属（一度）、教育、任职、持股；查询缓存于 `.cache/wikidata-queries/`，可断点续传 |
| `wikidata-xids` | Wikidata SPARQL | 为所有带 QID 的实体补齐 OpenSanctions/ICIJ/LittleSis/OpenSecrets/FEC/国会/CPED 外部 ID（跨层合并、直达链接、免审核对照） |
| `zhao` | programthink/zhao（GPL-3.0） | 人物 brief、公司、家族三元组 → 实体 + 家族档案；称谓映射为受控关系类型 |
| `us-officials` | 仓库：congress-legislators + FJC | 1970 年后的国会议员、历任总统/副总统、联邦法官；任期 → 职务；总统 → 法官 `appointed`；议员转任法官自动合并 |
| `opensanctions` | 仓库：OpenSanctions 全库 | 中美（含港澳台）政要/亲属关联人/被制裁者与机构 + 一度关系；Occupancy → 职务（职位节点）；Sanction → `legal`（from = 制裁机构） |
| `icij` | 仓库：ICIJ Offshore Leaks | 只投影已确认的匹配（审核裁决 same 或 Wikidata P10083）：人物 ↔ 离岸公司、中介、共同高管 |
| `fec` | 仓库：FEC 2000–2026 | PAC → 候选人、超级捐款人（单周期 ≥ 100 万美元）、已审核图谱人物的捐款；PAC 的关联公司若在图谱中则连上 |
| `littlesis` | 仓库：LittleSis | 已对照实体（Wikidata P3388/P3393 或审核裁决）的家族、社交、职业、持股、隶属、任职/董事、会员、游说、交易与大额捐赠关系（每个实体 ≤ 200 条） |

## 最小骨架

```ts
// tools/cli/src/connectors/example.ts
import path from 'node:path';
import { writeYaml } from '../lib.ts';
import { IdAllocator, type Connector } from './types.ts';

export const exampleConnector: Connector = {
  id: 'example',
  description: '示例：从某个公开数据集导入',
  async run({ args, dataDir, log }) {
    const ids = new IdAllocator('example', dataDir);       // 复用其他层已有的 id，避免重复实体
    const rows = await fetchSomething(args);                // 你的抓取逻辑（注意速率限制与 User-Agent）
    const entities = rows.map((r) => ({
      id: ids.resolve({ type: 'person', name: r.name, names: { en: r.name }, ids: { example: r.key }, born: r.born }),
      type: 'person', name: r.name, ids: { example: r.key }, sources: [{ url: r.url }],
    }));
    writeYaml(path.join(dataDir, 'imports/example/persons.yaml'), { entities }, '自动生成，请勿手改');
    log(`导入 ${entities.length} 人`);
  },
};
```

大体量数据源（数万实体以上）的做法：先在 `tools/cli/src/warehouse/sources.ts` 实现一个 `WarehouseSource`（下载 + DuckDB 入库），
再写一个从仓库读、用 `shards.ts` 的 `writeShards()` 输出 JSON 分片的投影连接器，并在 `layers.yaml` 中标 `bulk: true`；
需要人工确认身份的来源，在 `tools/cli/src/review/sources.ts` 加一个 `ReviewSource`。详见 [warehouse.md](warehouse.md)。

然后：

1. 在 `tools/cli/src/connectors/index.ts` 的 `CONNECTORS` 中登记；
2. 在 `data/layers.yaml` 增加一层（设置 `priority`、`license`、`defaultConfidence`）；
3. `npm run ctos -- ingest example` → `npm run ctos -- validate` → `npm run ctos -- build`。

## 约定

- **身份**：务必提供稳定的外部 ID（写进 `ids.<source>`），编译器会据此跨层合并；用 `IdAllocator.resolve()` 分配 id。
- **来源**：每个实体/关系都带来源 URL（指向原始记录页面）。
- **隐私**：不得输出 `FORBIDDEN_FIELDS` 中的字段；不导入未成年人（编译器也会兜底剔除）。
- **礼貌访问**：串行、限速、退避重试、合适的 User-Agent；遵守数据源的使用条款与许可（如 SEC 要求 UA 中含联系方式）。
- **可再生**：连接器输出应可随时整目录重建（先清空 `data/imports/<layer>/` 再写入）。

## 候选数据源（待实现）

- SEC EDGAR（Form 3/4/5 内部人、DEF 14A 董事会）→ `board/position/owner` 关系
- 美国国会财产申报（House Clerk / Senate eFD）→ 议员及配偶持股与交易
- 港交所披露易“权益披露” → 大股东持股
- Senate LDA 游说 / FARA 外国代理人登记 → `client` 关系
