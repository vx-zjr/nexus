/**
 * wikidata-xids 连接器：为图谱中所有带 Wikidata QID 的实体补齐“跨库外部 ID”（来自 Wikidata 志愿者人工维护的对照）。
 *
 *   P10632 OpenSanctions ID → ids.opensanctions     P10083 ICIJ Offshore Leaks ID → ids.icij
 *   P3388/P3393 LittleSis 人物/机构 ID → ids.littlesis   P2686/P4691 OpenSecrets ID → ids.opensecrets
 *   P1839 FEC ID → ids.fec   P7057 FEC 竞选委员会 ID → ids.fec_committee   P1157 国会传记 ID → ids.bioguide
 *   P5142 中国政治精英数据库（CPED）ID → ids.cped
 *
 * 作用：① 外部 ID 相同的实体在编译时自动合并（跨数据层去重）；② 档案面板显示直达链接；
 *       ③ ICIJ/LittleSis/FEC 投影时作为“已确认”的身份对照（无需人工审核）。
 * 用法：npm run ctos -- ingest wikidata-xids   （查询结果缓存 7 天，可断点续传）
 */
import path from 'node:path';
import { buildGraphData } from '../lib.ts';
import { sparql } from './wikidata.ts';
import type { Connector } from './types.ts';
import { resetDir, writeShards } from './shards.ts';

const LAYER = 'wikidata-xids';
const BATCH = 400;

export const XID_PROPS: Record<string, string> = {
  P10632: 'opensanctions',
  P10083: 'icij',
  P3388: 'littlesis',
  P3393: 'littlesis',
  P2686: 'opensecrets',
  P4691: 'opensecrets',
  P1839: 'fec',
  P7057: 'fec_committee',
  P1157: 'bioguide',
  P5142: 'cped',
};

export const wikidataXidsConnector: Connector = {
  id: 'wikidata-xids',
  description: '为带 QID 的实体补齐跨库 ID（OpenSanctions/ICIJ/LittleSis/OpenSecrets/FEC/国会/CPED），来自 Wikidata',
  async run({ dataDir, log }) {
    log('编译图谱，收集 QID …');
    const data = buildGraphData({ dataDir, layout: false, metrics: false });
    const byQid = new Map<string, { id: string; type: string; name: string }>();
    for (const e of data.entities) if (e.ids.wikidata && /^Q\d+$/.test(e.ids.wikidata)) byQid.set(e.ids.wikidata, { id: e.id, type: e.type, name: e.name });
    const qids = [...byQid.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    log(`带 QID 的实体 ${qids.length}，分 ${Math.ceil(qids.length / BATCH)} 批查询`);
    const props = Object.keys(XID_PROPS).map((p) => `wdt:${p}`).join(' ');
    const found = new Map<string, Record<string, string[]>>();
    for (let i = 0; i < qids.length; i += BATCH) {
      const b = qids.slice(i, i + BATCH);
      if ((i / BATCH) % 10 === 0) log(`  批次 ${i / BATCH + 1}/${Math.ceil(qids.length / BATCH)}`);
      const rows = await sparql(`SELECT ?item ?p ?v WHERE { VALUES ?item { ${b.map((q) => `wd:${q}`).join(' ')} } VALUES ?p { ${props} } ?item ?p ?v }`);
      for (const r of rows) {
        const key = XID_PROPS[r.p.replace('http://www.wikidata.org/prop/direct/', '')];
        if (!key || !r.v) continue;
        const m = found.get(r.item) ?? found.set(r.item, {}).get(r.item)!;
        (m[key] ??= []).includes(r.v) || m[key].push(r.v);
      }
    }
    const entities = [...found].map(([qid, m]) => {
      const e = byQid.get(qid)!;
      const ids: Record<string, string> = { wikidata: qid };
      const extra: Record<string, string[]> = {};
      for (const [k, vs] of Object.entries(m)) {
        ids[k] = vs[0];
        if (vs.length > 1) extra[k] = vs;
      }
      return { id: e.id, type: e.type, name: e.name, ids, ...(Object.keys(extra).length ? { attrs: { xids: extra } } : {}), sources: [`https://www.wikidata.org/wiki/${qid}`] };
    });
    const outDir = path.join(dataDir, 'imports', LAYER);
    resetDir(outDir);
    writeShards(outDir, 'entities', entities, `自动生成：ingest ${LAYER}（${new Date().toISOString().slice(0, 10)}）。来源 Wikidata（CC0）。请勿手改。`);
    const count = (k: string) => entities.filter((e) => e.ids[k]).length;
    log(`wikidata-xids：${entities.length} 个实体获得跨库 ID —— ` + [...new Set(Object.values(XID_PROPS))].map((k) => `${k} ${count(k)}`).join('，'));
  },
};
