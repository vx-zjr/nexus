/**
 * us-officials 连接器：从仓库生成“美国官员”图谱层
 *   - 国会议员（unitedstates/congress-legislators，CC0）：最后任期结束于 1970 年后者；任期 → 职务；跨库 ID（FEC/OpenSecrets/Wikidata…）
 *   - 历任总统、副总统（同上 executive.json）
 *   - 联邦法官（FJC 传记目录，公共领域）：1970 年后仍在任者；任命 → 职务；“任命总统”→ appointed 关系
 * 州议员、联邦行政任命官员（PLUM）由 opensanctions 连接器提供（OpenSanctions 已整合并去重）。
 *
 * 用法：npm run ctos -- ingest us-officials   （需先 ctos warehouse ingest congress fjc）
 */
import path from 'node:path';
import { all, openWarehouse } from '../warehouse/db.ts';
import { IdAllocator, type Connector } from './types.ts';
import { compact, resetDir, writeShards } from './shards.ts';

const LAYER = 'us-officials';
const SINCE = '1970';
const TODAY = new Date().toISOString().slice(0, 10);
const CONGRESS_SRC = { url: 'https://github.com/unitedstates/congress-legislators', title: 'unitedstates/congress-legislators', publisher: 'The @unitedstates project (CC0)' };
const FJC_SRC = { url: 'https://www.fjc.gov/history/judges', title: 'Biographical Directory of Article III Federal Judges', publisher: 'Federal Judicial Center' };

interface Term {
  type: string;
  start: string;
  end: string;
  state?: string;
  district?: number;
  party?: string;
}
interface Legislator {
  id: Record<string, unknown>;
  name: { first?: string; middle?: string; last?: string; suffix?: string; nickname?: string; official_full?: string };
  bio?: { birthday?: string; gender?: string };
  terms: Term[];
  family?: { name: string; relation: string }[];
  status?: string;
}

const fullName = (n: Legislator['name']) => n.official_full ?? [n.first, n.middle, n.last, n.suffix].filter(Boolean).join(' ');
const initials = (s?: string) => (s ?? '').split(/[\s.]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');

function termTitle(t: Term): { title: string; org: string } {
  if (t.type === 'sen') return { title: `美国参议员（${t.state}）`, org: 'us-senate' };
  if (t.type === 'rep') return { title: `美国众议员（${t.state}${t.district !== undefined && t.district > 0 ? `-${t.district}` : t.district === 0 ? '-AL' : ''}）`, org: 'us-house' };
  if (t.type === 'prez') return { title: '美国总统', org: 'us-white-house' };
  if (t.type === 'viceprez') return { title: '美国副总统', org: 'us-white-house' };
  return { title: t.type, org: 'us-white-house' };
}

/** 合并同一职务的连续任期（例如连任多届的众议员） */
function mergeTerms(terms: Term[]) {
  const out: { title: string; org: string; from: string; to?: string; current?: boolean }[] = [];
  for (const t of [...terms].sort((a, b) => a.start.localeCompare(b.start))) {
    const { title, org } = termTitle(t);
    const last = out.at(-1);
    if (last && last.title === title && last.to && t.start.slice(0, 4) <= String(Number(last.to.slice(0, 4)) + 1)) {
      last.to = t.end;
    } else out.push({ title, org, from: t.start, to: t.end });
  }
  for (const p of out) {
    if (p.to && p.to > TODAY) {
      delete p.to;
      p.current = true;
    }
  }
  return out;
}

const FAMILY: Record<string, { type: string; dir: 'named-parent' | 'member-parent' | 'sym' }> = {
  son: { type: 'parent', dir: 'named-parent' },
  daughter: { type: 'parent', dir: 'named-parent' },
  father: { type: 'parent', dir: 'member-parent' },
  mother: { type: 'parent', dir: 'member-parent' },
  brother: { type: 'sibling', dir: 'sym' },
  sister: { type: 'sibling', dir: 'sym' },
  husband: { type: 'spouse', dir: 'sym' },
  wife: { type: 'spouse', dir: 'sym' },
};

export const usOfficialsConnector: Connector = {
  id: 'us-officials',
  description: '美国官员：国会议员（1970–）、历任总统/副总统、联邦法官（FJC，1970–）；来自数据仓库',
  async run({ dataDir, log }) {
    const wh = await openWarehouse({ readOnly: true });
    const legislators = await all<Legislator>(wh.conn, `SELECT id, name, bio, terms, family, status FROM us_legislators`);
    const executive = await all<Legislator>(wh.conn, `SELECT id, name, bio, terms FROM us_executive`);
    const judges = await all<Record<string, string | null>>(wh.conn, `SELECT * FROM fjc_judges`);
    const service = await all<Record<string, string | null>>(wh.conn, `SELECT * FROM fjc_service ORDER BY nid, _sequence`);
    wh.close();

    const ids = new IdAllocator(LAYER, dataDir);
    const entities: Record<string, unknown>[] = [];
    const relations: Record<string, unknown>[] = [];
    const byBioguide = new Map<string, string>();
    const byName = new Map<string, string>();
    /** 姓|名|出生年 → 国会/行政人物，用于识别后来出任联邦法官的议员（如 Abner Mikva、James Buckley） */
    const byPersonKey = new Map<string, Record<string, unknown>>();
    const personKey = (first?: string | null, last?: string | null, born?: string | null) =>
      first && last && born ? `${last.toLowerCase().replace(/[^a-z]/g, '')}|${first.toLowerCase().replace(/[^a-z]/g, '')}|${born.slice(0, 4)}` : '';

    // ---- 国会议员 + 总统/副总统（同一人可能两边都有：按 bioguide 合并任期） ----
    const people = new Map<string, Legislator>();
    for (const l of [...legislators, ...executive]) {
      const key = String(l.id.bioguide ?? `${fullName(l.name)}|${l.bio?.birthday ?? ''}`);
      const prev = people.get(key);
      if (prev) prev.terms = [...prev.terms, ...l.terms];
      else people.set(key, { ...l, terms: [...l.terms] });
    }
    for (const l of people.values()) {
      const lastEnd = l.terms.map((t) => t.end).sort().at(-1) ?? '';
      if (lastEnd < SINCE) continue;
      const en = fullName(l.name);
      const qid = typeof l.id.wikidata === 'string' ? l.id.wikidata : undefined;
      const fecIds = Array.isArray(l.id.fec) ? (l.id.fec as string[]) : [];
      const extIds = compact({
        wikidata: qid,
        bioguide: l.id.bioguide as string | undefined,
        opensecrets: l.id.opensecrets as string | undefined,
        govtrack: l.id.govtrack !== undefined ? String(l.id.govtrack) : undefined,
        fec: fecIds[0],
      }) as Record<string, string>;
      const id = ids.resolve({ type: 'person', name: en, names: { en }, ids: extIds, born: l.bio?.birthday });
      if (l.id.bioguide) byBioguide.set(String(l.id.bioguide), id);
      byName.set(en.toLowerCase(), id);
      if (l.name.first && l.name.last) byName.set(`${l.name.first} ${l.name.last}`.toLowerCase(), id);
      const positions = mergeTerms(l.terms);
      const current = positions.some((p) => p.current);
      const party = l.terms.at(-1)?.party;
      const top = positions.find((p) => p.org === 'us-white-house') ? 1 : positions.find((p) => p.org === 'us-senate') ? 3 : 4;
      const ent = compact({
          id,
          type: 'person',
          name: en,
          names: { en },
          aliases: l.name.nickname ? [`${l.name.nickname} ${l.name.last}`] : undefined,
          gender: l.bio?.gender === 'F' ? 'F' : l.bio?.gender === 'M' ? 'M' : undefined,
          born: l.bio?.birthday,
          country: ['US'],
          sectors: ['politics'],
          tier: current ? top : Math.min(5, top + 1),
          status: current ? 'active' : undefined,
          summary: positions.map((p) => `${p.title} ${p.from.slice(0, 4)}–${p.current ? '今' : (p.to ?? '').slice(0, 4)}`).slice(-3).join('；'),
          positions,
          ids: extIds,
          tags: ['us-official', l.terms.some((t) => t.type === 'sen' || t.type === 'rep') ? 'us-congress' : 'us-executive', party ? `party:${party}` : undefined].filter(Boolean),
          attrs: compact({ party, fec_ids: fecIds.length > 1 ? fecIds : undefined, ballotpedia: l.id.ballotpedia as string | undefined }),
          sources: [CONGRESS_SRC],
        }) as Record<string, unknown>;
      entities.push(ent);
      const pk = personKey(l.name.first, l.name.last, l.bio?.birthday);
      if (pk) byPersonKey.set(pk, ent);
    }
    // 国会家族关系（congress-legislators 的 family 字段：member 是 named 的 son/daughter/…）
    let famN = 0;
    for (const l of people.values()) {
      const me = l.id.bioguide ? byBioguide.get(String(l.id.bioguide)) : undefined;
      if (!me) continue;
      for (const f of l.family ?? []) {
        const other = byName.get(f.name.toLowerCase());
        const map = FAMILY[f.relation.toLowerCase()];
        if (!other || other === me) continue;
        const r = map ?? { type: 'relative', dir: 'sym' as const };
        const [from, to] = r.dir === 'named-parent' ? [other, me] : [me, other];
        relations.push({ from, to, type: r.type, label: map ? undefined : f.relation, confidence: 'confirmed', sources: [CONGRESS_SRC] });
        famN++;
      }
    }

    // ---- 联邦法官 ----
    const presidents = new Map<string, string>();
    for (const l of executive) {
      if (!l.terms.some((t) => t.type === 'prez')) continue;
      const key = `${(l.name.last ?? '').toLowerCase()}|${(l.name.first ?? '').toLowerCase()}`;
      const id = (l.id.bioguide ? byBioguide.get(String(l.id.bioguide)) : undefined) ?? byName.get(fullName(l.name).toLowerCase());
      if (!id) continue;
      presidents.set(`${key}|${initials(l.name.middle)}`, id);
      if (!presidents.has(key)) presidents.set(key, id);
      else presidents.set(key, 'AMBIGUOUS');
    }
    const presidentId = (name?: string | null) => {
      if (!name) return undefined;
      const parts = name.replace(/\s+(Jr|Sr)\.?$/i, '').split(/\s+/);
      const first = parts[0].toLowerCase(), last = parts.at(-1)!.toLowerCase();
      const mid = initials(parts.slice(1, -1).join(' '));
      const exact = presidents.get(`${last}|${first}|${mid}`);
      const loose = presidents.get(`${last}|${first}`);
      return exact ?? (loose && loose !== 'AMBIGUOUS' ? loose : undefined);
    };
    const courtId = new Map<string, string>();
    const courtOf = (court: string) => {
      if (court === 'Supreme Court of the United States') return 'us-supreme-court';
      let id = courtId.get(court);
      if (!id) {
        id = ids.resolve({ type: 'org', name: court, names: { en: court } });
        courtId.set(court, id);
        const tier = /Court of Appeals/.test(court) ? 3 : 4;
        entities.push({ id, type: 'org', name: court, names: { en: court }, orgType: 'court', country: ['US'], sectors: ['judiciary'], tier, sources: [FJC_SRC] });
      }
      return id;
    };
    const serviceBy = new Map<string, Record<string, string | null>[]>();
    for (const s of service) (serviceBy.get(String(s.nid)) ?? serviceBy.set(String(s.nid), []).get(String(s.nid))!).push(s);
    let judgeN = 0, apptN = 0;
    for (const j of judges) {
      const svc = serviceBy.get(String(j.nid)) ?? [];
      if (!svc.some((s) => !s.termination_date || s.termination_date >= SINCE)) continue;
      const en = [j.first_name, j.middle_name, j.last_name, j.suffix].filter(Boolean).join(' ');
      const pad = (v?: string | null) => (v ? v.padStart(2, '0') : undefined);
      const born = j.birth_year ? [j.birth_year, pad(j.birth_month), pad(j.birth_day)].filter(Boolean).join('-') : undefined;
      const died = j.death_year ? [j.death_year, pad(j.death_month), pad(j.death_day)].filter(Boolean).join('-') : undefined;
      const same = byPersonKey.get(personKey(j.first_name, j.last_name, born));
      const id = same ? String(same.id) : ids.resolve({ type: 'person', name: en, names: { en }, ids: { fjc: String(j.nid) }, born });
      const positions = svc.map((s) =>
        compact({
          title: `${s.appointment_title ?? '法官'}，${s.court_name}`,
          org: s.court_name ? courtOf(s.court_name) : undefined,
          from: s.commission_date ?? undefined,
          to: s.termination_date ?? undefined,
          current: s.termination_date ? undefined : true,
        }),
      );
      const scotus = svc.some((s) => s.court_name === 'Supreme Court of the United States');
      const appeals = svc.some((s) => /Court of Appeals/.test(s.court_name ?? ''));
      const status = died ? 'deceased' : svc.some((s) => !s.termination_date) ? 'active' : 'retired';
      if (same) {
        // 议员转任法官：职务、来源、标签并入同一人
        same.positions = [...(same.positions as unknown[]), ...positions];
        same.ids = { ...(same.ids as object), fjc: String(j.nid) };
        same.sectors = ['politics', 'judiciary'];
        same.tags = [...(same.tags as string[]), 'us-federal-judge'];
        same.sources = [...(same.sources as unknown[]), { ...FJC_SRC, url: `https://www.fjc.gov/node/${j.nid}` }];
        same.status = status;
        if (died) same.died = died;
        same.tier = Math.min(Number(same.tier ?? 5), scotus ? 2 : appeals ? 3 : 4);
      } else entities.push(
        compact({
          id,
          type: 'person',
          name: en,
          names: { en },
          gender: j.gender === 'Female' ? 'F' : j.gender === 'Male' ? 'M' : undefined,
          born,
          died,
          country: ['US'],
          sectors: ['judiciary'],
          tier: scotus ? 2 : appeals ? 3 : 4,
          status,
          summary: positions.map((p) => p.title).join('；'),
          positions,
          ids: { fjc: String(j.nid) },
          tags: ['us-official', 'us-federal-judge'],
          sources: [{ ...FJC_SRC, url: `https://www.fjc.gov/node/${j.nid}` }],
        }),
      );
      if (!same) judgeN++;
      for (const s of svc) {
        const p = presidentId(s.appointing_president);
        if (p) {
          relations.push(compact({ from: p, to: id, type: 'appointed', label: `${s.appointment_title ?? '法官'}，${s.court_name}`, since: s.commission_date ?? undefined, confidence: 'confirmed', sources: [FJC_SRC] }));
          apptN++;
        }
      }
    }

    const outDir = path.join(dataDir, 'imports', LAYER);
    resetDir(outDir);
    const note = `自动生成：ingest ${LAYER}（${TODAY}）。来源：congress-legislators（CC0）、FJC（公共领域）。请勿手改。`;
    writeShards(outDir, 'entities', entities, note);
    writeShards(outDir, 'relations', relations, note);
    log(`us-officials：人物/机构 ${entities.length}（国会+行政 ${entities.length - judgeN - courtId.size}，法官 ${judgeN}，法院 ${courtId.size}），关系 ${relations.length}（家族 ${famN}，任命 ${apptN}）`);
  },
};
