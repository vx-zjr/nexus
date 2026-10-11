/**
 * 审核队列的数据源适配器：从仓库读出“待与图谱人物/机构比对”的外部记录，并提供审核时展示的上下文。
 * 新增来源（FEC 捐款人、LittleSis …）= 在这里加一个 ReviewSource。
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import { all, lit, tableExists } from '../warehouse/db.ts';
import { iso2 } from './names.ts';

export interface ExtRecord {
  id: string;
  name: string;
  kind: 'person' | 'org';
  countries: string[];
  /** 记录所属的数据集/泄露批次 */
  dataset?: string;
  detail?: string;
  /** 记录的活动年份范围（如捐款周期），用于排除已故或未成年时期的不可能匹配 */
  years?: [number, number];
}

export interface ContextItem {
  /** 关系描述，如 “shareholder of” */
  link: string;
  id: string;
  name: string;
  kind?: string;
  detail?: string;
  dataset?: string;
  /** 方向：out = 外部记录 → 对象；in = 对象 → 外部记录 */
  dir: 'out' | 'in';
}

export interface ReviewSource {
  id: string;
  label: string;
  /** 图谱实体上记录该来源外部 ID 的键（已有该 ID 的实体与记录视为已对照，不再生成候选） */
  idKey: string;
  /** 国家无区分度（如 FEC 全是美国）：歧义度超过上限的名字键一律跳过，不再以“国家相符”放行 */
  capAmbiguity?: boolean;
  /** 参与比对的仓库表（不存在则跳过） */
  table: string;
  records(conn: DuckDBConnection): Promise<ExtRecord[]>;
  context(conn: DuckDBConnection, ids: string[]): Promise<Record<string, ContextItem[]>>;
  url(id: string): string;
}

/** 名字像公司（ICIJ 的 officer 既可能是人也可能是公司） */
export const ORG_LIKE = /\b(limited|ltd|inc|corp|corporation|company|co\.|llc|s\.a\.|plc|holdings?|group|trust|foundation|bank|investments?|enterprises?|international|capital|management|partners|fund|services|nominees?|trustees?)\b|有限公司|集团/i;

const splitCodes = (s: string | null) => (s ? s.split(/[;,]/).map((c) => iso2(c.trim())).filter(Boolean) : []);

const icij: ReviewSource = {
  id: 'icij',
  label: 'ICIJ 离岸解密（Offshore Leaks）',
  idKey: 'icij',
  table: 'icij_officers',
  async records(conn) {
    const rows = await all<{ id: string; name: string; codes: string | null; dataset: string | null; t: string }>(
      conn,
      `SELECT node_id AS id, name, country_codes AS codes, sourceID AS dataset, 'officer' AS t FROM icij_officers WHERE name IS NOT NULL
       UNION ALL SELECT node_id, name, country_codes, sourceID, 'intermediary' FROM icij_intermediaries WHERE name IS NOT NULL
       UNION ALL SELECT node_id, name, country_codes, sourceID, 'entity' FROM icij_entities WHERE name IS NOT NULL`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.t === 'entity' || ORG_LIKE.test(r.name) ? 'org' : 'person',
      countries: splitCodes(r.codes),
      dataset: r.dataset ?? undefined,
      detail: r.t,
    }));
  },
  async context(conn, ids) {
    if (!ids.length) return {};
    const list = ids.map(lit).join(',');
    const rows = await all<ContextItem & { ext: string }>(
      conn,
      `SELECT DISTINCT r.node_id_start AS ext, r.link, n.node_id AS id, n.name, n.kind, n.detail, n.sourceID AS dataset, 'out' AS dir
         FROM icij_relationships r JOIN icij_nodes n ON n.node_id = r.node_id_end
        WHERE r.node_id_start IN (${list}) AND r.rel_type IN ('officer_of', 'intermediary_of', 'connected_to')
       UNION
       SELECT DISTINCT r.node_id_end, r.link, n.node_id, n.name, n.kind, n.detail, n.sourceID, 'in'
         FROM icij_relationships r JOIN icij_nodes n ON n.node_id = r.node_id_start
        WHERE r.node_id_end IN (${list}) AND r.rel_type IN ('officer_of', 'intermediary_of', 'connected_to')
       LIMIT 5000`,
    );
    const out: Record<string, ContextItem[]> = {};
    for (const { ext, ...c } of rows) (out[ext] ??= []).push(c);
    return out;
  },
  url: (id) => `https://offshoreleaks.icij.org/nodes/${id}`,
};

const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`);

/**
 * FEC 个人捐款人（派生表 fec_donors，累计 ≥ 1 万美元者）。键 = 归一姓名|州；州只用于区分同名，不进入图谱。
 * 注意：FEC 捐款人信息依法（52 U.S.C. §30111(a)(4)）不得用于募捐或商业目的。
 */
const fec: ReviewSource = {
  id: 'fec',
  label: 'FEC 政治献金（个人捐款人）',
  idKey: 'fec_donor',
  capAmbiguity: true,
  table: 'fec_donors',
  async records(conn) {
    const rows = await all<{ id: string; name: string; total: number; n: number; c0: number; c1: number; employers: string[] | null; occupations: string[] | null }>(
      conn,
      `SELECT donor_key AS id, name, total, n, c0, c1, employers, occupations FROM fec_donors WHERE total >= 10000 AND name IS NOT NULL AND trim(name) <> ''`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: 'person' as const,
      countries: ['US'],
      dataset: `${money(Number(r.total))} · ${r.n} 笔 · ${r.c0}–${r.c1}`,
      years: [Number(r.c0) - 1, Number(r.c1)] as [number, number],
      detail: [...(r.employers ?? []), ...(r.occupations ?? [])].filter(Boolean).slice(0, 4).join(' / '),
    }));
  },
  async context(conn, ids) {
    if (!ids.length) return {};
    const rows = await all<{ ext: string; id: string; name: string; tp: string | null; cand: string | null; total: number; c0: number; c1: number }>(
      conn,
      `SELECT * FROM (
         SELECT r.donor_key AS ext, r.cmte_id AS id, coalesce(c.CMTE_NM, r.cmte_id) AS name, c.CMTE_TP AS tp, n.CAND_NAME AS cand, r.total, r.c0, r.c1,
                row_number() OVER (PARTITION BY r.donor_key ORDER BY r.total DESC) AS rk
         FROM fec_donor_recipients r LEFT JOIN fec_committees c ON c.CMTE_ID = r.cmte_id
         LEFT JOIN (SELECT CAND_ID, any_value(CAND_NAME) AS CAND_NAME FROM fec_cn GROUP BY 1) n ON n.CAND_ID = c.CAND_ID
         WHERE r.donor_key IN (${ids.map(lit).join(',')})) WHERE rk <= 10`,
    );
    const out: Record<string, ContextItem[]> = {};
    for (const r of rows) {
      (out[r.ext] ??= []).push({
        link: `捐 ${money(Number(r.total))}（${r.c0}–${r.c1}）`,
        id: r.id,
        name: r.cand ? `${r.name}（${r.cand}）` : r.name,
        kind: 'committee',
        detail: r.tp ?? undefined,
        dataset: 'FEC',
        dir: 'out',
      });
    }
    return out;
  },
  url: (id) => `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(id.split('|')[0])}&contributor_state=${encodeURIComponent(id.split('|')[1] ?? '')}`,
};

/** LittleSis 人物/机构（无 Wikidata 对照的部分经审核接入；国家信息稀疏，常见名一律跳过） */
const littlesis: ReviewSource = {
  id: 'littlesis',
  label: 'LittleSis 美国政商关系库',
  idKey: 'littlesis',
  capAmbiguity: true,
  table: 'ls_entities',
  async records(conn) {
    const rows = await all<{ id: string; name: string; ext: string; blurb: string | null; types: string[] | null; nat: string[] | null }>(
      conn,
      `SELECT CAST(id AS VARCHAR) AS id, name, primary_ext AS ext, blurb, types,
              from_json(extensions->'Person'->'nationality', '["VARCHAR"]') AS nat
       FROM ls_entities WHERE name IS NOT NULL`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.ext === 'Person' ? ('person' as const) : ('org' as const),
      countries: (r.nat ?? []).filter((c) => /^[A-Za-z]{2}$/.test(c)).map((c) => c.toUpperCase()),
      dataset: (r.types ?? []).slice(0, 3).join(' / '),
      detail: r.blurb ?? undefined,
    }));
  },
  async context(conn, ids) {
    if (!ids.length) return {};
    const list = ids.filter((x) => /^\d+$/.test(x)).join(',') || '0';
    const rows = await all<{ ext: string; id: string; name: string; d: string | null; cat: number; dir: 'out' | 'in' }>(
      conn,
      `SELECT * FROM (
         SELECT CAST(r.entity1_id AS VARCHAR) AS ext, CAST(e.id AS VARCHAR) AS id, e.name, r.description1 AS d, r.category_id AS cat, 'out' AS dir,
                row_number() OVER (PARTITION BY r.entity1_id ORDER BY r.category_id = 5, r.is_current DESC NULLS LAST) AS rk
         FROM ls_relationships r JOIN ls_entities e ON e.id = r.entity2_id WHERE r.entity1_id IN (${list})
         UNION ALL
         SELECT CAST(r.entity2_id AS VARCHAR), CAST(e.id AS VARCHAR), e.name, r.description2, r.category_id, 'in',
                row_number() OVER (PARTITION BY r.entity2_id ORDER BY r.category_id = 5, r.is_current DESC NULLS LAST)
         FROM ls_relationships r JOIN ls_entities e ON e.id = r.entity1_id WHERE r.entity2_id IN (${list})
       ) WHERE rk <= 8`,
    );
    const CAT = ['', '任职', '教育', '会员', '家族', '捐赠', '交易', '游说', '社交', '职业', '持股', '隶属', '关联'];
    const out: Record<string, ContextItem[]> = {};
    for (const r of rows) (out[r.ext] ??= []).push({ link: `${CAT[Number(r.cat)] ?? r.cat}${r.d ? `（${r.d}）` : ''}`, id: r.id, name: r.name, dataset: 'LittleSis', dir: r.dir });
    return out;
  },
  url: (id) => `https://littlesis.org/entities/${id}`,
};

export const REVIEW_SOURCES: Record<string, ReviewSource> = { icij, fec, littlesis };

export async function availableSources(conn: DuckDBConnection) {
  const out: ReviewSource[] = [];
  for (const s of Object.values(REVIEW_SOURCES)) if (await tableExists(conn, s.table)) out.push(s);
  return out;
}
