/**
 * fec 连接器：把 FEC 政治献金（2000–2026）中与图谱人物相关的资金流投影进图谱。
 *
 *   ① PAC → 候选人：图谱中有 FEC 候选人 ID 的人物（国会议员、总统等），其收到的 PAC 直接捐款/独立支出
 *      （每人取金额前 TOP_PACS 个，另加累计 ≥ BIG_PAC 的全部）；PAC 的关联机构（CONNECTED_ORG）若在图谱中则连上。
 *   ② 超级捐款人：任一周期个人捐款 ≥ MEGA 的捐款人 → 人物节点（已审核对应到图谱人物的直接并入）+ 捐款边。
 *   ③ 已审核确认的图谱人物（data/curated/_matches/fec.yaml）→ 其全部大额捐款（累计 ≥ MIN_EDGE）。
 * 个人捐款的接收方若是候选人的竞选委员会，边直接连到候选人；其他委员会（超级 PAC、政党委员会…）建机构节点。
 *
 * 隐私：图谱中不出现捐款人的城市/邮编/州（仓库键中的州只用于区分同名）。
 * 法律：FEC 捐款人信息不得用于募捐或商业目的（52 U.S.C. §30111(a)(4)）。本层仅供研究。
 * 用法：npm run ctos -- ingest fec   （需先 ctos warehouse ingest fec；如需审核：ctos review gen fec）
 */
import path from 'node:path';
import type { Entity } from '@nexus/core';
import { buildGraphData } from '../lib.ts';
import { all, lit, openWarehouse, tableExists } from '../warehouse/db.ts';
import { loadDecisions } from '../review/store.ts';
import { orgKeys } from '../review/names.ts';
import { IdAllocator, type Connector } from './types.ts';
import { compact, resetDir, writeShards } from './shards.ts';

const LAYER = 'fec';
const TODAY = new Date().toISOString().slice(0, 10);
const TOP_PACS = 25;
const BIG_PAC = 100_000;
const MEGA = 1_000_000;
const MIN_EDGE = 2_000;
const TOP_RECIPIENTS = 40;
const SRC = { url: 'https://www.fec.gov/data/browse-data/?tab=bulk-data', title: 'FEC bulk data', publisher: 'U.S. Federal Election Commission' };

const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`);
const cycles = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);
/** “GRIFFIN, KENNETH C.” → “Kenneth C. Griffin” */
export function fecName(n: string): string {
  const [last, rest] = n.split(',').map((x) => x.trim());
  const cap = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return rest ? cap(`${rest} ${last}`) : cap(n);
}
const PAC_TP: Record<string, string> = {
  '24K': 'PAC 直接捐款',
  '24Z': 'PAC 实物捐赠',
  '24E': '独立支出（支持）',
  '24A': '独立支出（反对）',
};

export const fecConnector: Connector = {
  id: 'fec',
  description: 'FEC 政治献金：PAC→候选人、超级捐款人、已审核图谱人物的捐款（2000–2026）；来自数据仓库',
  async run({ dataDir, log }) {
    log('编译图谱，收集 FEC 候选人 ID …');
    const data = buildGraphData({ dataDir, layout: false, metrics: false });
    const candToEntity = new Map<string, string>();
    const orgByKey = new Map<string, string>();
    for (const e of data.entities) {
      const fecIds = new Set<string>([e.ids.fec, ...((e.attrs?.fec_ids as string[]) ?? []), ...(((e.attrs?.xids as Record<string, string[]>)?.fec) ?? [])].filter(Boolean));
      for (const f of fecIds) if (/^[HSP]\d/.test(f)) candToEntity.set(f, e.id);
      if (e.type === 'org' && !e.layers.every((l) => l === LAYER)) for (const k of orgKeys(e.names.en ?? e.name)) if (!orgByKey.has(k)) orgByKey.set(k, e.id);
    }
    log(`图谱中带 FEC 候选人 ID 的人物 ${new Set(candToEntity.values()).size}（ID ${candToEntity.size}）`);
    const confirmed = loadDecisions(LAYER).filter((d) => d.decision === 'same');

    const wh = await openWarehouse({ readOnly: true });
    let pac: { cmte_id: string; cand_id: string; tp: string; total: number; n: number; c0: number; c1: number }[] = [];
    let donors: { donor_key: string; name: string; total: number; n: number; c0: number; c1: number; max_cycle_total: number; employers: string[] | null; occupations: string[] | null }[] = [];
    let recips: { donor_key: string; cmte_id: string; total: number; n: number; c0: number; c1: number }[] = [];
    let cmtes: Map<string, { CMTE_ID: string; CMTE_NM: string; CMTE_TP: string | null; ORG_TP: string | null; CONNECTED_ORG_NM: string | null; CAND_ID: string | null; CMTE_PTY_AFFILIATION: string | null }>;
    let cmteCand: Map<string, string>;
    try {
      for (const t of ['fec_pas2', 'fec_ccl', 'fec_donors', 'fec_donor_recipients', 'fec_committees']) {
        if (!(await tableExists(wh.conn, t))) throw new Error(`仓库缺少 ${t}：先运行 npm run ctos -- warehouse ingest fec`);
      }
      const cands = [...candToEntity.keys()].map(lit).join(',');
      log('PAC → 候选人 汇总 …');
      pac = await all(wh.conn, `SELECT CMTE_ID AS cmte_id, CAND_ID AS cand_id, TRANSACTION_TP AS tp, sum(TRY_CAST(TRANSACTION_AMT AS DOUBLE)) AS total, count(*) AS n, min(cycle) AS c0, max(cycle) AS c1
        FROM fec_pas2 WHERE CAND_ID IN (${cands}) AND TRANSACTION_TP IN ('24K', '24Z', '24E', '24A') GROUP BY ALL HAVING total > 0`);
      // 竞选委员会 → 候选人（主委员会 P / 授权委员会 A）
      const ccl = await all<{ CMTE_ID: string; CAND_ID: string }>(wh.conn, `SELECT DISTINCT CMTE_ID, CAND_ID FROM fec_ccl WHERE CMTE_DSGN IN ('P', 'A') AND CAND_ID IN (${cands})`);
      cmteCand = new Map(ccl.map((r) => [r.CMTE_ID, r.CAND_ID]));
      log('超级捐款人与已确认捐款人 …');
      const keys = confirmed.map((d) => lit(d.ext)).join(',') || "''";
      donors = await all(wh.conn, `SELECT donor_key, name, total, n, c0, c1, max_cycle_total, employers, occupations FROM fec_donors
        WHERE max_cycle_total >= ${MEGA} OR donor_key IN (${keys})`);
      const dk = donors.map((d) => lit(d.donor_key)).join(',') || "''";
      recips = await all(wh.conn, `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY donor_key ORDER BY total DESC) AS rk FROM fec_donor_recipients
        WHERE donor_key IN (${dk}) AND total >= ${MIN_EDGE}) WHERE rk <= ${TOP_RECIPIENTS}`);
      const needCm = new Set([...pac.map((p) => p.cmte_id), ...recips.map((r) => r.cmte_id)]);
      const cmRows = needCm.size
        ? await all<{ CMTE_ID: string; CMTE_NM: string; CMTE_TP: string | null; ORG_TP: string | null; CONNECTED_ORG_NM: string | null; CAND_ID: string | null; CMTE_PTY_AFFILIATION: string | null }>(
            wh.conn,
            `SELECT CMTE_ID, CMTE_NM, CMTE_TP, ORG_TP, CONNECTED_ORG_NM, CAND_ID, CMTE_PTY_AFFILIATION FROM fec_committees WHERE CMTE_ID IN (${[...needCm].map(lit).join(',')})`,
          )
        : [];
      cmtes = new Map(cmRows.map((r) => [r.CMTE_ID, r]));
    } finally {
      wh.close();
    }

    const alloc = new IdAllocator(LAYER, dataDir);
    const entities = new Map<string, Record<string, unknown>>();
    const relations: Record<string, unknown>[] = [];
    // 委员会节点
    const cmteNode = (id: string) => {
      const c = cmtes.get(id);
      const name = c?.CMTE_NM ?? id;
      const eid = alloc.resolve({ type: 'org', name, ids: { fec_committee: id } }, { strict: true });
      if (!entities.has(eid) && !alloc.known(eid)) {
        entities.set(eid, compact({
          id: eid,
          type: 'org',
          name,
          names: { en: name },
          orgType: 'committee',
          country: ['US'],
          sectors: ['politics'],
          tier: 5,
          summary: `FEC 政治委员会（类型 ${c?.CMTE_TP ?? '?'}${c?.CMTE_PTY_AFFILIATION ? `，${c.CMTE_PTY_AFFILIATION}` : ''}）${c?.CONNECTED_ORG_NM ? `，关联机构：${c.CONNECTED_ORG_NM}` : ''}`,
          ids: { fec_committee: id },
          tags: ['fec-committee', ...(c?.CMTE_TP ? [`fec-type:${c.CMTE_TP}`] : [])],
          sources: [{ url: `https://www.fec.gov/data/committee/${id}/`, title: name, publisher: 'FEC' }],
        }));
        // 关联机构（公司/工会/行业协会）若已在图谱中 → 连上
        const conn = c?.CONNECTED_ORG_NM ? orgKeys(c.CONNECTED_ORG_NM).map((k) => orgByKey.get(k)).find(Boolean) : undefined;
        if (conn) relations.push({ from: conn, to: eid, type: 'parent-org', label: '关联 PAC（FEC）', confidence: 'confirmed', sources: [`https://www.fec.gov/data/committee/${id}/`] });
      }
      return eid;
    };

    // ① PAC → 候选人
    const byCand = new Map<string, typeof pac>();
    for (const p of pac) (byCand.get(p.cand_id) ?? byCand.set(p.cand_id, []).get(p.cand_id)!).push(p);
    let pacN = 0;
    for (const [cand, list] of byCand) {
      const to = candToEntity.get(cand)!;
      const sorted = list.sort((a, b) => b.total - a.total);
      for (const [i, p] of sorted.entries()) {
        if (i >= TOP_PACS && p.total < BIG_PAC) continue;
        const from = cmteNode(p.cmte_id);
        relations.push(compact({
          from,
          to,
          type: p.tp === '24A' ? 'related' : 'donor',
          label: `${PAC_TP[p.tp] ?? p.tp} ${money(Number(p.total))}（${cycles(p.c0, p.c1)}，${p.n} 笔）`,
          since: String(p.c0 - 1),
          until: String(p.c1),
          confidence: 'confirmed',
          sources: [`https://www.fec.gov/data/committee/${p.cmte_id}/`],
          attrs: { amount: Math.round(Number(p.total)), fec_tp: p.tp },
        }));
        pacN++;
      }
    }

    // ②③ 个人捐款人
    const donorEntity = new Map<string, string>(confirmed.map((d) => [d.ext, d.entity]));
    const existing = (id: string): Pick<Entity, 'id' | 'type' | 'name'> | undefined => alloc.existing(id);
    let megaN = 0, donN = 0;
    for (const d of donors) {
      let eid = donorEntity.get(d.donor_key);
      const name = fecName(d.name);
      const summary = `FEC 个人捐款累计 ${money(Number(d.total))}（${cycles(d.c0, d.c1)}，${d.n} 笔；单周期最高 ${money(Number(d.max_cycle_total))}）`;
      if (eid && existing(eid)) {
        entities.set(eid, compact({ id: eid, type: 'person', name: existing(eid)!.name, tags: ['fec-donor'], attrs: { fec_donor_total: Math.round(Number(d.total)) }, sources: [SRC] }));
      } else {
        eid = alloc.resolve({ type: 'person', name, names: { en: name }, ids: { fec_donor: d.donor_key } }, { strict: true });
        entities.set(eid, compact({
          id: eid,
          type: 'person',
          name,
          names: { en: name },
          country: ['US'],
          sectors: ['business'],
          tier: Number(d.max_cycle_total) >= 10 * MEGA ? 3 : 4,
          summary: `${summary}${d.employers?.length ? `；雇主：${d.employers.filter(Boolean).slice(0, 3).join(' / ')}` : ''}${d.occupations?.length ? `；职业：${d.occupations.filter(Boolean).slice(0, 2).join(' / ')}` : ''}`,
          ids: { fec_donor: d.donor_key },
          tags: ['fec-donor', 'fec-megadonor'],
          sources: [{ url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(d.name)}`, title: `FEC：${d.name}`, publisher: 'FEC' }],
        }));
        megaN++;
      }
      for (const r of recips.filter((x) => x.donor_key === d.donor_key)) {
        const cand = cmteCand.get(r.cmte_id);
        const to = cand ? candToEntity.get(cand)! : cmteNode(r.cmte_id);
        if (to === eid) continue;
        relations.push(compact({
          from: eid,
          to,
          type: 'donor',
          label: `个人捐款 ${money(Number(r.total))}（${cycles(r.c0, r.c1)}${cand ? `，经 ${cmtes.get(r.cmte_id)?.CMTE_NM ?? r.cmte_id}` : ''}）`,
          since: String(r.c0 - 1),
          until: String(r.c1),
          confidence: 'confirmed',
          sources: [`https://www.fec.gov/data/committee/${r.cmte_id}/`],
          attrs: { amount: Math.round(Number(r.total)) },
        }));
        donN++;
      }
    }

    const outDir = path.join(dataDir, 'imports', LAYER);
    resetDir(outDir);
    const note = `自动生成：ingest ${LAYER}（${TODAY}）。来源 FEC 批量数据（美国政府公共领域）；捐款人信息不得用于募捐或商业目的（52 U.S.C. §30111(a)(4)）。请勿手改。`;
    const ents = [...entities.values()];
    writeShards(outDir, 'entities', ents, note);
    writeShards(outDir, 'relations', relations, note);
    log(`fec：实体 ${ents.length}（委员会 ${ents.filter((e) => e.type === 'org').length}，超级捐款人 ${megaN}，已确认捐款人 ${confirmed.length}），` +
      `关系 ${relations.length}（PAC→候选人 ${pacN}，个人捐款 ${donN}）`);
  },
};
