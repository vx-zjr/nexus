/**
 * littlesis 连接器：把 LittleSis（美国政商“谁认识谁”数据库）中与图谱已对照实体相关的关系投影进图谱。
 *
 * 对照（种子）：其他层已有的 ids.littlesis（Wikidata P3388/P3393 志愿者对照、精编层手写）+ 审核裁决 same
 *   （data/curated/_matches/littlesis.yaml，`ctos review gen littlesis` 生成候选）；被裁决 different 的排除。
 * 收录：种子的家族、社交、职业、持股、隶属、任职/董事、会员、游说、交易、通用关系，以及大额（≥ BIG_DONATION）捐赠；
 *       每个种子最多 MAX_PER_SEED 条（按类别优先级、在任优先）；关系另一端以最小字段建节点（名称、简介、类型）。
 * 不收：教育关系（Wikidata 已覆盖）、小额政治捐款（FEC 层更完整）。
 * 方向：description1 是 entity1 相对 entity2 的身份；Ownership 为 entity1 拥有 entity2；Hierarchy 为 entity1 是 entity2 的下属。
 * 许可：LittleSis 数据 CC BY-SA 4.0（衍生数据须同样共享、署名）。
 * 用法：npm run ctos -- ingest littlesis   （需先 ctos warehouse ingest littlesis）
 */
import path from 'node:path';
import { all, lit, openWarehouse } from '../warehouse/db.ts';
import { loadDecisions } from '../review/store.ts';
import { IdAllocator, type Connector } from './types.ts';
import { compact, resetDir, writeShards } from './shards.ts';

const LAYER = 'littlesis';
const TODAY = new Date().toISOString().slice(0, 10);
const MAX_PER_SEED = 200;
const BIG_DONATION = 100_000;
const PUBLISHER = 'LittleSis（CC BY-SA 4.0）';
/** 类别优先级（越小越先保留）：家族、社交、职业、持股、隶属、任职、会员、游说、交易、通用、捐赠 */
const CAT_PRIORITY: Record<number, number> = { 4: 0, 8: 1, 9: 2, 10: 3, 11: 4, 1: 5, 3: 6, 7: 7, 6: 8, 12: 9, 5: 10 };

/** LittleSis 日期 “2007-00-00” → “2007”，“2010-06-00” → “2010-06” */
export function lsDate(s?: string | null): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s);
  if (!m || m[1] === '0000') return undefined;
  return [m[1], m[2] && m[2] !== '00' ? m[2] : undefined, m[2] !== '00' && m[3] && m[3] !== '00' ? m[3] : undefined].filter(Boolean).join('-');
}

interface Rel {
  id: string;
  entity1_id: string;
  entity2_id: string;
  category_id: number;
  description1: string | null;
  description2: string | null;
  amount: number | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean | null;
  description: string | null;
  board: boolean | null;
  url: string | null;
}

/** 关系映射：返回 [from, to, type, label] 或 null（跳过） */
export function mapRel(r: Pick<Rel, 'category_id' | 'description1' | 'description2' | 'amount' | 'board'>, e1: string, e2: string, e1IsPerson: boolean, e2IsPerson: boolean): [string, string, string, string | undefined] | null {
  const d1 = (r.description1 ?? '').trim().toLowerCase(), d2 = (r.description2 ?? '').trim().toLowerCase();
  const label = r.description1?.trim() || undefined;
  switch (Number(r.category_id)) {
    case 1: // 任职
      if (!e1IsPerson || e2IsPerson) return [e1, e2, 'related', label ?? 'position'];
      return [e1, e2, r.board ? 'board' : 'position', label];
    case 3:
      return [e1, e2, 'member', label];
    case 4: {
      if (!e1IsPerson || !e2IsPerson) return null;
      if (/^(husband|wife|spouse)$/.test(d1)) return [e1, e2, 'spouse', undefined];
      if (/ex-(husband|wife|spouse)|former (husband|wife|spouse)|divorced/.test(d1)) return [e1, e2, 'ex-spouse', undefined];
      if (/partner|fianc/.test(d1)) return [e1, e2, 'partner', label];
      if (/in-law/.test(d1) || /in-law/.test(d2)) return [e1, e2, 'in-law', label];
      if (/^(father|mother|parent|step-?father|step-?mother|stepparent)$/.test(d1)) return [e1, e2, 'parent', /step/.test(d1) ? label : undefined];
      if (/^(son|daughter|child|step-?son|step-?daughter|stepchild)$/.test(d1)) return [e2, e1, 'parent', /step/.test(d1) ? label : undefined];
      if (/^(brother|sister|sibling|half-brother|half-sister|twin)/.test(d1)) return [e1, e2, 'sibling', /half|twin/.test(d1) ? label : undefined];
      return [e1, e2, 'relative', label];
    }
    case 5:
      return r.amount && r.amount >= BIG_DONATION ? [e1, e2, 'donor', `捐赠 $${Math.round(r.amount).toLocaleString('en-US')}`] : null;
    case 6: // 交易/服务：服务方 → 客户
      if (/client/.test(d1) && !/client/.test(d2)) return [e2, e1, 'client', r.description2?.trim() || 'service'];
      if (/client/.test(d2) && !/client/.test(d1)) return [e1, e2, 'client', label ?? 'service'];
      return [e1, e2, 'related', label ?? '商业往来'];
    case 7:
      return [e1, e2, 'related', `游说${label ? `（${label}）` : ''}`];
    case 8:
      if (!e1IsPerson || !e2IsPerson) return [e1, e2, 'associate', label];
      return [e1, e2, /friend/.test(d1) ? 'friend' : 'associate', label];
    case 9:
      if (/partner/.test(d1)) return [e1, e2, 'business-partner', undefined];
      if (/client/.test(d2) && !/client/.test(d1)) return [e1, e2, 'client', label];
      if (/client/.test(d1) && !/client/.test(d2)) return [e2, e1, 'client', r.description2?.trim()];
      if (/colleague/.test(d1) && e1IsPerson && e2IsPerson) return [e1, e2, 'colleague', undefined];
      return [e1, e2, 'associate', label ?? '职业关系'];
    case 10:
      return [e1, e2, 'owner', label];
    case 11: // entity1 是 entity2 的下属
      if (e1IsPerson || e2IsPerson) return [e1, e2, 'related', label];
      return [e2, e1, 'parent-org', label];
    case 12:
      return [e1, e2, 'related', label ?? r.description2?.trim() ?? '关联'];
    default:
      return null;
  }
}

const ORG_TYPE: [RegExp, string][] = [
  [/Political Party/i, 'party'],
  [/Government Body/i, 'government'],
  [/School|University|College/i, 'university'],
  [/Think Tank|Policy\/Think Tank/i, 'think-tank'],
  [/Media/i, 'media'],
  [/Philanthropy|Foundation/i, 'foundation'],
  [/PAC|Political Fundraising/i, 'committee'],
  [/Bank/i, 'bank'],
  [/Investment|Hedge Fund|Private Equity|Venture Capital/i, 'fund'],
  [/Not-for-Profit|Nonprofit|Advocacy|Membership Organization/i, 'ngo'],
  [/Business|Company|Law Firm|Lobbying Firm/i, 'company'],
];
const SECTOR: [RegExp, string][] = [
  [/Elected Representative|Political Candidate|Government Body|Political Party|PAC|Political Fundraising|Lobbyist|Lobbying/i, 'politics'],
  [/Bank|Investment|Hedge Fund|Private Equity|Venture Capital/i, 'finance'],
  [/Media|Journalist|Writer/i, 'media'],
  [/Academic|School|University|Think Tank|Scholar/i, 'academia'],
  [/Philanthropy|Not-for-Profit|Nonprofit|Advocacy|Activist/i, 'ngo'],
  [/Business|Company|Executive|Law Firm|Lawyer/i, 'business'],
];

export const littlesisConnector: Connector = {
  id: 'littlesis',
  description: 'LittleSis：已对照（Wikidata/审核）的美国政商人物与机构的家族、社交、职业、持股、董事、游说等关系；来自数据仓库',
  async run({ dataDir, log }) {
    const alloc = new IdAllocator(LAYER, dataDir);
    const decisions = loadDecisions(LAYER);
    const rejected = new Set(decisions.filter((d) => d.decision === 'different').map((d) => `${d.entity}|${d.ext}`));
    const seedOf = new Map<string, string>(); // LittleSis id → 图谱 id
    for (const [ext, entity] of alloc.withExt('littlesis')) if (!rejected.has(`${entity}|${ext}`)) seedOf.set(ext.replace(/-.*$/, ''), entity);
    const fromIds = seedOf.size;
    for (const d of decisions) if (d.decision === 'same') seedOf.set(String(d.ext).replace(/-.*$/, ''), d.entity);
    const outDir = path.join(dataDir, 'imports', LAYER);
    resetDir(outDir);
    if (!seedOf.size) {
      log('littlesis：没有已对照的实体（Wikidata P3388/P3393 或审核裁决）。先运行 ingest wikidata-xids 或 review gen littlesis。');
      return;
    }
    log(`已对照实体 ${seedOf.size}（Wikidata/精编层 ID ${fromIds}，审核 ${seedOf.size - fromIds}）`);

    const wh = await openWarehouse({ readOnly: true });
    let rels: Rel[], ents: { id: string; name: string; blurb: string | null; primary_ext: string; types: string[] | null; start_date: string | null; end_date: string | null; qid: string | null; url: string | null }[];
    try {
      const seeds = [...seedOf.keys()].filter((x) => /^\d+$/.test(x)).join(',');
      await wh.conn.run(`CREATE TEMP TABLE seeds AS SELECT unnest([${seeds}]::BIGINT[]) AS id`);
      rels = await all<Rel>(wh.conn, `
        WITH cand AS (
          SELECT r.*, s.id AS seed, coalesce(TRY_CAST(r.category_attributes->>'is_board' AS BOOLEAN), false) AS board
          FROM ls_relationships r JOIN seeds s ON s.id IN (r.entity1_id, r.entity2_id)
          WHERE r.category_id <> 2 AND (r.category_id <> 5 OR r.amount >= ${BIG_DONATION})
        ), ranked AS (
          SELECT *, row_number() OVER (PARTITION BY seed ORDER BY CASE category_id ${Object.entries(CAT_PRIORITY).map(([c, p]) => `WHEN ${c} THEN ${p}`).join(' ')} ELSE 99 END,
                 is_current DESC NULLS LAST, coalesce(end_date, '9999') DESC, amount DESC NULLS LAST) AS rk
          FROM cand
        )
        SELECT DISTINCT ON (id) id, entity1_id, entity2_id, category_id, description1, description2, amount, start_date, end_date, is_current, description, board, url
        FROM ranked WHERE rk <= ${MAX_PER_SEED}`);
      const ids = [...new Set(rels.flatMap((r) => [r.entity1_id, r.entity2_id]))].map(String);
      ents = ids.length
        ? await all(wh.conn, `SELECT id, name, blurb, primary_ext, types, start_date, end_date, qid, url FROM ls_entities WHERE id IN (${ids.map(lit).join(',')})`)
        : [];
    } finally {
      wh.close();
    }

    const idOf = new Map<string, string>();
    const isPerson = new Map<string, boolean>();
    const entities: Record<string, unknown>[] = [];
    for (const e of ents) {
      const lid = String(e.id);
      const person = e.primary_ext === 'Person';
      isPerson.set(lid, person);
      const src = [{ url: e.url ?? `https://littlesis.org/entities/${lid}`, title: e.name, publisher: PUBLISHER }];
      const seed = seedOf.get(lid);
      const types = (e.types ?? []).join(' ');
      if (seed) {
        const ex = alloc.existing(seed);
        if (!ex) continue;
        idOf.set(lid, seed);
        entities.push({ id: seed, type: ex.type, name: ex.name, ids: { littlesis: lid }, tags: ['littlesis'], sources: src });
        continue;
      }
      const id = alloc.resolve({ type: person ? 'person' : 'org', name: e.name, names: { en: e.name }, ids: compact({ littlesis: lid, wikidata: e.qid ?? undefined }) as Record<string, string> }, { strict: true });
      idOf.set(lid, id);
      if (alloc.known(id)) {
        entities.push({ id, type: alloc.existing(id)!.type, name: alloc.existing(id)!.name, ids: { littlesis: lid }, tags: ['littlesis'], sources: src });
        continue;
      }
      const sectors = [...new Set(SECTOR.filter(([re]) => re.test(types)).map(([, s]) => s))];
      entities.push(compact({
        id,
        type: person ? 'person' : 'org',
        name: e.name,
        names: { en: e.name },
        orgType: person ? undefined : ORG_TYPE.find(([re]) => re.test(types))?.[1],
        summary: e.blurb ?? undefined,
        founded: person ? undefined : lsDate(e.start_date),
        dissolved: person ? undefined : lsDate(e.end_date),
        sectors: sectors.length ? sectors.slice(0, 2) : ['other'],
        tier: 5,
        ids: compact({ littlesis: lid, wikidata: e.qid ?? undefined }),
        tags: ['littlesis', ...(e.types ?? []).slice(0, 4).map((t) => `ls:${t}`)],
        sources: src,
      }));
    }

    const relations: Record<string, unknown>[] = [];
    const count: Record<string, number> = {};
    for (const r of rels) {
      const a = idOf.get(String(r.entity1_id)), b = idOf.get(String(r.entity2_id));
      if (!a || !b || a === b) continue;
      const m = mapRel(r, a, b, isPerson.get(String(r.entity1_id)) ?? false, isPerson.get(String(r.entity2_id)) ?? false);
      if (!m) continue;
      const [from, to, type, label] = m;
      count[type] = (count[type] ?? 0) + 1;
      relations.push(compact({
        from,
        to,
        type,
        label,
        since: lsDate(r.start_date),
        until: lsDate(r.end_date),
        current: r.is_current ?? undefined,
        confidence: 'reported',
        sources: [r.url ?? `https://littlesis.org/relationships/${r.id}`],
      }));
    }
    const note = `自动生成：ingest ${LAYER}（${TODAY}）。来源 LittleSis（CC BY-SA 4.0，须署名、相同方式共享），仅含已对照实体的关系。请勿手改。`;
    writeShards(outDir, 'entities', entities, note);
    writeShards(outDir, 'relations', relations, note);
    log(`littlesis：实体 ${entities.length}，关系 ${relations.length}（${Object.entries(count).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join('，')}）`);
  },
};
