# 数据模式参考

权威定义：输入模式 `packages/core/src/schema.ts`（zod），编译后结构 `packages/core/src/types.ts`，受控词表 `packages/core/src/vocab.ts`。
本文件是给人和 AI 看的速查表。

## 文件种类（按字段自动识别）

| 种类 | 识别条件 | 用途 |
|---|---|---|
| 单实体 | 有 `id` + `type` | `curated/persons/<id>.yaml` |
| 档案 | 有 `id` + `kind` | `curated/dossiers/<id>.yaml`（可内嵌 relations） |
| 批量 | 有 `entities` / `relations` / `dossiers` 之一 | 机构合集、主题关系、连接器输出 |

批量文件与档案文件可写文件级 `sources`、`confidence`，作为其中未写来源的关系/实体的默认值。
文件名以 `_` 或 `.` 开头的会被忽略（可用于草稿与说明）。

## 实体字段

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 小写 kebab-case，全局唯一且稳定 |
| type | person \| org | |
| name | string | 主显示名 |
| names | {zh, en, …} | 各语言名 |
| aliases | string[] | 曾用名、英文名、化名 |
| country | string \| string[] | ISO 3166-1 alpha-2（CN/HK/MO/TW/US…） |
| sectors | string[] | politics military security judiciary diplomacy business finance tech media academia culture sports religion ngo family other |
| tier | 1–5 | 重要性分级 |
| summary / notes | markdown | 简述 / 研究笔记 |
| ids | {wikidata, zhao, …} | 外部 ID，**相同外部 ID 的实体会自动合并** |
| links | string[] | 参考链接 |
| sources | Source[] | 来源，可简写为 URL 字符串 |
| tags | string[] | 自由标签（如 princeling、zhijiang-xinjun、purged-2026） |
| attrs | object | 任意自定义数据（不得包含隐私字段） |
| sameAs | id \| id[] | 声明与另一实体为同一人/同一机构，编译时强制合并 |
| distinctFrom | id[] | 声明不是同一实体，消除“疑似重复”警告 |
| **person** gender, born, died, birthplace, status, positions[], education[], netWorth | | |
| **org** orgType, founded, dissolved, parent, hq | | parent 会生成 parent-org 关系 |

`positions[]`: `{ title, org?, from?, to?, current?, note?, confidence?, sources? }` —— 有 `org` 时自动生成 `position` 关系。
`education[]`: `{ org, degree?, field?, from?, to? }` —— 自动生成 `alumni` 关系。

## 关系字段

| 字段 | 说明 |
|---|---|
| from / to | 实体 id。有向关系读作“from 是 to 的 …” |
| type | 见下表 |
| label | 细化称谓：长子、前妻、秘书、早期股东、50% … |
| since / until / current | 时间 |
| confidence | confirmed / reported / alleged / disputed / rumor |
| sources | 来源 |
| note | 备注（如传闻出处、争议说明） |
| retract | true = 撤回低优先级层中相同 (from, type, to) 的关系 |

简写：`[from, type, to, label?, confidence?]`

## 关系类型

运行 `npm run ctos -- vocab` 查看最新列表。

| 类别 | 类型 |
|---|---|
| 家族 | parent(→子女) spouse ex-spouse partner sibling in-law relative |
| 人际 | friend classmate colleague associate related |
| 政治 | patron(→门生) aide(秘书→上司) ally rival appointed(→被任命者) |
| 职务 | position member founder board advisor |
| 资本 | owner investor donor business-partner client |
| 教育 | alumni |
| 司法 | legal(发起方→对象) |
| 机构间 | parent-org(→下属) org-partner |

## 档案字段

`{ id, kind, name, names?, country?, head?, core?, outer?, summary?, notes?, tags?, sources?, confidence?, relations? }`

- `kind`: family 家族 / faction 派系 / network 关系网 / institution 机构班子 / case 案件 / watchlist 观察名单
- 未在 core/outer 中列出、但出现在内嵌关系里的实体会自动加入档案（有成员列表时作为 outer）。

## 编译产物 graph.json

```ts
interface GraphData {
  meta: { schemaVersion, generatedAt, layers[], counts{...}, issues{errors, warnings} };
  entities: Entity[];   // 含派生字段 layers files dossiers degree score community x y search
  relations: Relation[];// 含 id category directed layer file derived
  dossiers: Dossier[];
  issues: Issue[];
}
```
