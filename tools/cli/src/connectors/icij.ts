/**
 * icij 连接器：把审核通过（decision: same）的 ICIJ 离岸解密记录投影进图谱。
 *
 * 流程：ctos warehouse ingest icij → ctos review gen icij → 人工/AI 审核（前端“审核”视图或 ctos review decide）
 *       → ctos ingest icij（本连接器）
 * 收录：已确认的人物/机构 ↔ 其担任股东/董事/受益人等角色的离岸公司；中介机构（律所/注册代理）；
 *       离岸公司的其他高管（每家公司 ≤ MAX_CO_OFFICERS 人时，用于发现白手套/代持人，最小字段呈现）。
 * 不收：地址节点、注册地址关系（仓库入库时已剔除）。
 * 提示：持有离岸公司本身并不违法（ICIJ 原话：“There are legitimate uses for offshore companies and trusts”）。
 * 许可：ICIJ Offshore Leaks Database，ODbL 1.0 + CC BY-SA 3.0，须注明来源 ICIJ。
 */
import path from 'node:path';
import { all, lit, openWarehouse } from '../warehouse/db.ts';
import { loadDecisions } from '../review/store.ts';
import { iso2 } from '../review/names.ts';
import { ORG_LIKE } from '../review/sources.ts';
import { IdAllocator, type Connector } from './types.ts';
import { compact, resetDir, writeShards } from './shards.ts';

const LAYER = 'icij';
const TODAY = new Date().toISOString().slice(0, 10);
const MAX_CO_OFFICERS = 10;
const PUBLISHER = 'ICIJ Offshore Leaks Database（ODbL / CC BY-SA）';
const nodeUrl = (id: string) => `https://offshoreleaks.icij.org/nodes/${id}`;

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
/** ICIJ 日期 “29-JAN-2007” / “2007-01-29” → YYYY-MM-DD */
export function icijDate(s?: string | null): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec(s.trim());
  if (m) return `${m[3]}-${MONTHS[m[2].toUpperCase()] ?? '01'}-${m[1].padStart(2, '0')}`;
  const n = /^(\d{4})(-\d{2})?(-\d{2})?/.exec(s.trim());
  return n ? n[0] : undefined;
}

/** officer_of 的角色 → 关系类型 */
export function roleType(link: string): 'owner' | 'board' | 'related' {
  const l = link.toLowerCase();
  if (/shareholder|owner|beneficiar|beneficial|ubo|nominee shareholder|protector|settlor|member of/.test(l)) return 'owner';
  if (/director|president|secretary|treasurer|manager|officer|chairman|signatory|power of attorney|proxy|representative|partner/.test(l)) return 'board';
  return 'related';
}

interface Node {
  node_id: string;
  name: string;
  kind: string;
  countries: string | null;
  country_codes: string | null;
  sourceID: string | null;
  jurisdiction?: string | null;
  jurisdiction_description?: string | null;
  incorporation_date?: string | null;
  inactivation_date?: string | null;
  struck_off_date?: string | null;
  status?: string | null;
  company_type?: string | null;
}
interface Rel {
  start: string;
  end: string;
  rel_type: string;
  link: string;
  start_date: string | null;
  end_date: string | null;
  sourceID: string | null;
}

export const icijConnector: Connector = {
  id: 'icij',
  description: 'ICIJ 离岸解密：已审核确认的人物/机构及其离岸公司、中介、共同高管（需先 review）',
  async run({ dataDir, log }) {
    const outDir = path.join(dataDir, 'imports', LAYER);
    resetDir(outDir);
    const note = `自动生成：ingest ${LAYER}（${TODAY}）。来源 ICIJ Offshore Leaks Database（ODbL 1.0 / CC BY-SA 3.0），仅含审核确认（data/curated/_matches/icij.yaml）或 Wikidata（P10083）/精编层已给出 ICIJ ID 的匹配。请勿手改。`;
    // 已确认的对照：① 审核裁决 same ② 其他层已有的 ids.icij（Wikidata P10083 志愿者人工对照、精编层手写）；被裁决为 different 的排除
    const alloc = new IdAllocator(LAYER, dataDir);
    const decisions = loadDecisions(LAYER);
    const rejected = new Set(decisions.filter((d) => d.decision === 'different').map((d) => `${d.entity}|${d.ext}`));
    const extToEntity = new Map<string, string>();
    for (const [ext, entity] of alloc.withExt('icij')) if (!rejected.has(`${entity}|${ext}`)) extToEntity.set(ext, entity);
    const fromIds = extToEntity.size;
    for (const d of decisions) if (d.decision === 'same') extToEntity.set(d.ext, d.entity);
    if (!extToEntity.size) {
      log('icij：尚无已确认的匹配（审核裁决或 Wikidata P10083），未生成任何数据。先运行 ctos review gen icij 并审核。');
      return;
    }
    log(`已确认对照 ${extToEntity.size}（审核 ${extToEntity.size - fromIds}，Wikidata/精编层 ID ${fromIds}）`);
    const wh = await openWarehouse({ readOnly: true });
    let nodes: Node[], rels: Rel[];
    try {
      const seeds = [...extToEntity.keys()].map(lit).join(',');
      const REL = `rel_type IN ('officer_of', 'intermediary_of')`;
      // 1 跳：已确认记录 ↔ 公司
      rels = await all<Rel>(wh.conn, `SELECT node_id_start AS start, node_id_end AS "end", rel_type, link, start_date, end_date, sourceID FROM icij_relationships
        WHERE ${REL} AND (node_id_start IN (${seeds}) OR node_id_end IN (${seeds}))`);
      const companies = [...new Set(rels.flatMap((r) => [r.start, r.end]).filter((x) => !extToEntity.has(x)))];
      // 2 跳：这些公司的其他高管/股东/中介（公司人数不多时）
      if (companies.length) {
        const list = companies.map(lit).join(',');
        const co = await all<Rel>(wh.conn, `SELECT node_id_start AS start, node_id_end AS "end", rel_type, link, start_date, end_date, sourceID FROM icij_relationships
          WHERE ${REL} AND node_id_end IN (${list}) AND node_id_end IN (
            SELECT node_id_end FROM icij_relationships WHERE ${REL} AND node_id_end IN (${list}) GROUP BY 1 HAVING count(DISTINCT node_id_start) <= ${MAX_CO_OFFICERS})`);
        const seen = new Set(rels.map((r) => `${r.start}|${r.end}|${r.link}`));
        for (const r of co) if (!seen.has(`${r.start}|${r.end}|${r.link}`)) rels.push(r);
      }
      const ids = [...new Set(rels.flatMap((r) => [r.start, r.end]).concat([...extToEntity.keys()]))].map(lit).join(',');
      nodes = await all<Node>(wh.conn, `
        SELECT node_id, name, 'entity' AS kind, countries, country_codes, sourceID, jurisdiction, jurisdiction_description, incorporation_date, inactivation_date, struck_off_date, status, company_type FROM icij_entities WHERE node_id IN (${ids})
        UNION ALL SELECT node_id, name, 'officer', countries, country_codes, sourceID, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM icij_officers WHERE node_id IN (${ids})
        UNION ALL SELECT node_id, name, 'intermediary', countries, country_codes, sourceID, NULL, NULL, NULL, NULL, status, NULL, NULL FROM icij_intermediaries WHERE node_id IN (${ids})
        UNION ALL SELECT node_id, name, 'other', countries, country_codes, sourceID, NULL, NULL, NULL, NULL, NULL, type, NULL FROM icij_others WHERE node_id IN (${ids})`);
    } finally {
      wh.close();
    }

    const idOf = new Map<string, string>();
    const entities: Record<string, unknown>[] = [];
    for (const n of nodes) {
      const src = [{ url: nodeUrl(n.node_id), title: `${n.name}（${n.sourceID ?? 'ICIJ'}）`, publisher: PUBLISHER }];
      const matched = extToEntity.get(n.node_id);
      if (matched) {
        // 已确认的图谱实体：只补 ICIJ 外部 ID 与来源
        // 已确认的图谱实体：只补 ICIJ 外部 ID、标签与来源（名字等字段以更高优先级的层为准）
        const ex = alloc.existing(matched);
        if (!ex) {
          log(`  ! 跳过：图谱中已不存在实体 ${matched}（ICIJ ${n.node_id}）`);
          continue;
        }
        idOf.set(n.node_id, matched);
        entities.push({ id: matched, type: ex.type, name: ex.name, ids: { icij: n.node_id }, sources: src, tags: ['icij'] });
        continue;
      }
      const isOrg = n.kind === 'entity' || n.kind === 'other' || (n.kind !== 'entity' && ORG_LIKE.test(n.name));
      const country = [...new Set((n.country_codes ?? '').split(/[;,]/).map((c) => iso2(c.trim())).filter((c) => /^[A-Z]{2}$/.test(c)))];
      const juris = n.jurisdiction ? iso2(n.jurisdiction) : undefined;
      const id = alloc.resolve({ type: isOrg ? 'org' : 'person', name: n.name, ids: { icij: n.node_id } }, { strict: true });
      idOf.set(n.node_id, id);
      if (isOrg) {
        const offshore = n.kind === 'entity';
        entities.push(compact({
          id,
          type: 'org',
          name: n.name,
          names: { en: n.name },
          orgType: 'company',
          country: offshore && juris && /^[A-Z]{2}$/.test(juris) ? [juris] : country,
          founded: icijDate(n.incorporation_date),
          dissolved: icijDate(n.inactivation_date ?? n.struck_off_date),
          sectors: ['business'],
          tier: 5,
          summary: offshore
            ? `离岸实体（${n.jurisdiction_description ?? n.jurisdiction ?? '?'}）· ${n.sourceID ?? ''}${n.status ? ` · 状态 ${n.status}` : ''}`
            : n.kind === 'intermediary' ? `离岸服务中介 · ${n.sourceID ?? ''}` : `${n.sourceID ?? ''}`,
          ids: { icij: n.node_id },
          tags: ['icij', offshore ? 'offshore-entity' : `icij-${n.kind}`],
          sources: src,
        }));
      } else {
        // 共同高管/股东：最小化（姓名、国家）
        entities.push(compact({ id, type: 'person', name: n.name, names: { en: n.name }, country, sectors: ['other'], tier: 5, ids: { icij: n.node_id }, tags: ['icij', 'icij-officer'], sources: src }));
      }
    }
    const relations: Record<string, unknown>[] = [];
    for (const r of rels) {
      const a = idOf.get(r.start), b = idOf.get(r.end);
      if (!a || !b || a === b) continue;
      const type = r.rel_type === 'intermediary_of' ? 'client' : roleType(r.link);
      relations.push(compact({
        from: a,
        to: b,
        type,
        label: r.link,
        since: icijDate(r.start_date),
        until: icijDate(r.end_date),
        confidence: 'reported',
        sources: [nodeUrl(r.start)],
        note: r.sourceID ?? undefined,
      }));
    }
    writeShards(outDir, 'entities', entities, note);
    writeShards(outDir, 'relations', relations, note);
    log(`icij：确认匹配 ${extToEntity.size}，实体 ${entities.length}（含离岸公司 ${entities.filter((e) => (e.tags as string[]).includes('offshore-entity')).length}），关系 ${relations.length}`);
  },
};
