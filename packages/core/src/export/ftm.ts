/**
 * FollowTheMoney（FtM）导出器。
 *
 * FtM 是 OCCRP Aleph、OpenSanctions 等调查/合规系统使用的实体数据标准（https://followthemoney.tech）。
 * 输出为 JSON Lines：每行一个实体 { id, schema, properties: { 属性: [值…] } }，
 * 可直接 `ftm validate`、导入 Aleph（`alephclient write-entities`）、与 OpenSanctions 数据交叉比对。
 *
 * 映射（参照 OpenSanctions 对政要数据的建模习惯）：
 *   人物 → Person；企业/国企/银行/基金 → Company；政府/立法/司法/军队/委员会 → PublicBody；其他机构 → Organization
 *   家族 → Family；人际/政治 → Associate；政府职务 → Position + Occupancy；企业任职 → Employment
 *   董事 → Directorship；成员 → Membership；持股/投资 → Ownership；献金 → Payment；顾问/服务 → Representation
 *   制裁 → Sanction；母公司 → 子机构的 parent 属性；其余 → UnknownLink
 * 可信度没有对应字段，写入关系实体的 description（并可用 minConfidence 过滤）。
 */
import type { Entity, GraphData } from '../types.ts';
import { CONFIDENCE, RELATION_TYPES, type Confidence, type OrgType } from '../vocab.ts';

export interface FtmEntity {
  id: string;
  schema: string;
  properties: Record<string, string[]>;
}

export interface FtmOptions {
  /** 只导出不低于该可信度的关系（默认全部导出，可信度写在 description 中） */
  minConfidence?: Confidence;
  /** 实体 id 前缀（默认 nx-），用于和其他数据集的 id 区分命名空间 */
  prefix?: string;
}

const COMPANY_TYPES = new Set<OrgType>(['company', 'soe', 'bank', 'fund', 'media']);
const PUBLIC_TYPES = new Set<OrgType>(['government', 'legislature', 'court', 'military', 'committee']);
const ORG_TOPICS: Partial<Record<OrgType, string>> = {
  soe: 'gov.soe',
  bank: 'fin.bank',
  fund: 'fin.fund',
  government: 'gov.executive',
  legislature: 'gov.legislative',
  court: 'gov.judicial',
  military: 'gov.security',
};
const PEP_SECTORS = new Set(['politics', 'military', 'security', 'judiciary', 'diplomacy']);

/** 32 位 FNV-1a ×2，生成稳定的短 id */
function hash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function ftmSchemaOf(e: Entity): 'Person' | 'Company' | 'PublicBody' | 'Organization' {
  if (e.type === 'person') return 'Person';
  if (e.orgType && COMPANY_TYPES.has(e.orgType)) return 'Company';
  if (e.orgType && PUBLIC_TYPES.has(e.orgType)) return 'PublicBody';
  return 'Organization';
}

class Builder {
  readonly out = new Map<string, FtmEntity>();
  add(id: string, schema: string, props: Record<string, unknown>) {
    const ent = this.out.get(id) ?? { id, schema, properties: {} };
    for (const [k, v] of Object.entries(props)) {
      const vals = (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && String(x).trim() !== '').map((x) => String(x).trim());
      if (!vals.length) continue;
      const cur = (ent.properties[k] ??= []);
      for (const x of vals) if (!cur.includes(x)) cur.push(x);
    }
    this.out.set(id, ent);
    return ent;
  }
}

const isWiki = (u: string) => /wikipedia\.org\/wiki\//.test(u);

export function toFtM(data: GraphData, opts: FtmOptions = {}): FtmEntity[] {
  const P = opts.prefix ?? 'nx-';
  const eid = (id: string) => `${P}${id}`;
  const byId = new Map(data.entities.map((e) => [e.id, e]));
  const dossierName = new Map(data.dossiers.map((d) => [d.id, d.name]));
  const b = new Builder();
  const minRank = opts.minConfidence ? CONFIDENCE[opts.minConfidence].rank : 0;

  // ---------- 实体 ----------
  for (const e of data.entities) {
    const schema = ftmSchemaOf(e);
    const names = [...new Set([...Object.values(e.names), ...e.aliases])].filter((n) => n && n !== e.name);
    const urls = [...e.sources.map((s) => s.url).filter(Boolean), ...e.links] as string[];
    const common: Record<string, unknown> = {
      name: e.name,
      alias: names,
      country: e.country.map((c) => c.toLowerCase()),
      summary: e.summary,
      notes: e.notes,
      wikidataId: e.ids.wikidata,
      wikipediaUrl: urls.filter(isWiki),
      sourceUrl: [...new Set(urls.filter((u) => !isWiki(u)))],
      keywords: [...e.tags.filter((t) => !t.startsWith('party:')), ...e.dossiers.map((d) => dossierName.get(d) ?? d)],
      sector: e.sectors,
      status: e.status,
    };
    if (schema === 'Person') {
      const topics: string[] = [];
      if (e.sectors.some((s) => PEP_SECTORS.has(s)) && (e.tier ?? 5) <= 3) topics.push('role.pep');
      if (e.sectors.includes('politics')) topics.push('role.pol');
      if (e.sectors.includes('diplomacy')) topics.push('role.diplo');
      if (e.sectors.includes('family')) topics.push('role.rca');
      b.add(eid(e.id), 'Person', {
        ...common,
        gender: e.gender === 'M' ? 'male' : e.gender === 'F' ? 'female' : e.gender === 'X' ? 'other' : undefined,
        birthDate: e.born ?? undefined,
        deathDate: e.died ?? undefined,
        birthPlace: e.birthplace,
        nationality: e.country.map((c) => c.toLowerCase()),
        position: (e.positions ?? []).map((p) => p.title),
        political: typeof e.attrs?.party === 'string' ? e.attrs.party : undefined,
        topics,
      });
    } else {
      const topics = e.orgType && ORG_TOPICS[e.orgType] ? [ORG_TOPICS[e.orgType]] : [];
      if (e.orgType === 'party') topics.push('role.pol');
      b.add(eid(e.id), schema, {
        ...common,
        jurisdiction: e.country.map((c) => c.toLowerCase()),
        incorporationDate: e.founded ?? undefined,
        dissolutionDate: e.dissolved ?? undefined,
        legalForm: e.orgType,
        topics,
      });
    }
  }

  // ---------- 关系 ----------
  for (const r of data.relations) {
    if (CONFIDENCE[r.confidence].rank < minRank) continue;
    const f = byId.get(r.from), t = byId.get(r.to);
    if (!f || !t) continue;
    const def = RELATION_TYPES[r.type];
    const fs = ftmSchemaOf(f), ts = ftmSchemaOf(t);
    const urls = [...new Set(r.sources.map((s) => s.url).filter(Boolean) as string[])];
    const interval = {
      startDate: r.since ?? undefined,
      endDate: r.until ?? undefined,
      summary: r.label,
      description: [`可信度：${CONFIDENCE[r.confidence].zh}（${r.confidence}）`, r.note].filter(Boolean).join('；'),
      sourceUrl: urls,
      publisher: r.sources[0]?.publisher,
      recordId: r.id,
    };
    const rid = `${P}rel-${hash(r.id)}`;
    const role = r.label ? `${def.en}: ${r.label}` : def.en;
    const link = () => b.add(rid, 'UnknownLink', { subject: eid(r.from), object: eid(r.to), role, status: r.current ? 'current' : undefined, ...interval });

    switch (r.category) {
      case 'family': {
        if (fs !== 'Person' || ts !== 'Person') { link(); break; }
        const base: Record<string, string> = { parent: '子女/child', spouse: '配偶/spouse', 'ex-spouse': '前配偶/former spouse', partner: '伴侣/partner', sibling: '兄弟姐妹/sibling', 'in-law': '姻亲/in-law', relative: '亲属/relative' };
        b.add(rid, 'Family', { person: eid(r.from), relative: eid(r.to), relationship: r.label ? `${base[r.type]}: ${r.label}` : base[r.type], ...interval });
        break;
      }
      case 'social':
      case 'political': {
        if (r.type === 'legal') { link(); break; }
        if (fs === 'Person' && ts === 'Person') b.add(rid, 'Associate', { person: eid(r.from), associate: eid(r.to), relationship: r.label ? `${def.out}/${def.en}: ${r.label}` : `${def.out}/${def.en}`, ...interval });
        else link();
        break;
      }
      case 'professional': {
        if (r.type === 'position' && fs === 'Person' && ts !== 'Person') {
          if (ts === 'Company' || ts === 'Organization') {
            b.add(rid, 'Employment', { employee: eid(r.from), employer: eid(r.to), role: r.label, status: r.current ? 'current' : undefined, ...interval });
          } else {
            // 政府职务：Position（职位本身）+ Occupancy（某人在某段时间担任）
            const title = r.label ?? t.name;
            const posId = `${P}pos-${hash(`${t.id}|${title}`)}`;
            b.add(posId, 'Position', { name: title, organization: eid(t.id), country: t.country.map((c) => c.toLowerCase()) });
            b.add(rid, 'Occupancy', { holder: eid(r.from), post: posId, status: r.until ? 'ended' : r.current ? 'current' : undefined, ...interval });
          }
        } else if (r.type === 'board' && ts !== 'Person') {
          b.add(rid, 'Directorship', { director: eid(r.from), organization: eid(r.to), role: r.label ?? 'board member', ...interval });
        } else if (r.type === 'member' && ts !== 'Person') {
          b.add(rid, 'Membership', { member: eid(r.from), organization: eid(r.to), role: r.label, ...interval });
        } else if (r.type === 'advisor') {
          b.add(rid, 'Representation', { agent: eid(r.from), client: eid(r.to), role: r.label ?? 'advisor', ...interval });
        } else link();
        break;
      }
      case 'financial': {
        if ((r.type === 'owner' || r.type === 'investor') && ts === 'Company') {
          const pct = /(\d+(?:\.\d+)?)\s*%/.exec(r.label ?? '')?.[1];
          b.add(rid, 'Ownership', { owner: eid(r.from), asset: eid(r.to), percentage: pct, ownershipType: r.type === 'investor' ? 'investment' : undefined, role: r.label, ...interval });
        } else if (r.type === 'donor') {
          b.add(rid, 'Payment', { payer: eid(r.from), beneficiary: eid(r.to), purpose: r.label ? `政治献金/donation: ${r.label}` : '政治献金/donation', ...interval });
        } else if (r.type === 'client') {
          b.add(rid, 'Representation', { agent: eid(r.from), client: eid(r.to), role: r.label, ...interval });
        } else if (r.type === 'business-partner' && fs === 'Person' && ts === 'Person') {
          b.add(rid, 'Associate', { person: eid(r.from), associate: eid(r.to), relationship: r.label ? `生意伙伴/business partner: ${r.label}` : '生意伙伴/business partner', ...interval });
        } else link();
        break;
      }
      case 'education': {
        if (fs === 'Person') b.add(eid(r.from), 'Person', { education: [t.name, r.label].filter(Boolean).join(' · ') });
        link();
        break;
      }
      case 'legal': {
        if (/制裁|sanction/i.test(r.label ?? '')) {
          b.add(rid, 'Sanction', { entity: eid(r.to), authority: f.name, country: f.country.map((c) => c.toLowerCase()), program: r.label, reason: r.note, listingDate: r.since ?? undefined, ...interval });
        } else link();
        break;
      }
      case 'org': {
        if (r.type === 'parent-org' && ts !== 'Person' && fs !== 'Person') b.add(eid(r.to), ts, { parent: eid(r.from) });
        else link();
        break;
      }
      default:
        link();
    }
  }
  return [...b.out.values()];
}

export function toFtMJsonl(data: GraphData, opts?: FtmOptions): string {
  return toFtM(data, opts).map((e) => JSON.stringify(e)).join('\n') + '\n';
}

