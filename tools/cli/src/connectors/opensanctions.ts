/**
 * opensanctions 连接器：从仓库中的 OpenSanctions 全库（FtM）投影出与中美相关的图谱层。
 *
 * 圈定（种子）：
 *   人物  国籍/公民身份/国家 ∈ CN/HK/MO/TW/US，且主题含政要(role.pep*)、亲属关联人(role.rca)、政治人物、法官、外交、
 *         军方、寡头，或被制裁/反制裁/出口管制
 *   机构  CN/HK/MO/TW：被制裁、出口管制（实体清单）、强迫劳动清单、国企、军工；US：被中国/俄罗斯反制裁的机构
 *   （不收：仅因“禁止参与采购/debarment”“监管处罚”等上榜的普通个人与小企业）
 * 一度扩展：种子的家族、关联人、持股、任职、代理等关系的另一端（人物/机构）一并收录，以最小字段呈现。
 *
 * 映射：Occupancy → positions（职务标题取职位名）；Family/Associate/Ownership/Directorship/Membership/
 *       Employment/Representation/UnknownLink → relations；Sanction → legal 关系（from = 制裁机构）。
 * 已存在于更高优先级层（精编、Wikidata、美国官员）的人物：只补外部 ID、来源与关系，不重复写职务。
 * 隐私：仓库入库时已剔除地址/证件/联系方式；这里只取姓名、性别、生卒、职务、关系；非公众亲属只留出生年份。
 *
 * 许可：OpenSanctions 数据为 CC BY-NC 4.0（非商业使用，须署名）。
 * 用法：npm run ctos -- ingest opensanctions   （需先 ctos warehouse ingest opensanctions）
 */
import path from 'node:path';
import { all, lit, openWarehouse } from '../warehouse/db.ts';
import { IdAllocator, type Connector } from './types.ts';
import { compact, resetDir, writeShards } from './shards.ts';

const LAYER = 'opensanctions';
const TODAY = new Date().toISOString().slice(0, 10);
const PUBLISHER = 'OpenSanctions（CC BY-NC 4.0）';

const CN = ['cn', 'hk', 'mo', 'tw'];
const PERSON_TOPICS = ['role.pep', 'role.pep.frmr', 'role.pep.intl', 'role.pep.natl', 'role.pep.subn', 'role.rca', 'role.pol', 'role.judge',
  'role.diplo', 'role.oligarch', 'sanction', 'sanction.linked', 'sanction.counter', 'export.control', 'mil'];
const CN_ORG_TOPICS = ['sanction', 'sanction.linked', 'sanction.control', 'export.control', 'export.control.linked', 'forced.labor', 'gov.soe', 'mil', 'role.oligarch'];
const US_ORG_TOPICS = ['sanction.counter'];
const ORG_SCHEMAS = ['Company', 'Organization', 'LegalEntity', 'PublicBody'];
const REL_SCHEMAS = ['Family', 'Associate', 'Ownership', 'Directorship', 'Membership', 'Employment', 'Representation', 'UnknownLink'];
const arr = (xs: string[]) => `[${xs.map(lit).join(',')}]`;

type Props = Record<string, string[] | undefined>;
interface Row {
  id: string;
  schema: string;
  caption: string;
  countries: string[];
  topics: string[];
  datasets: string[];
  qid: string | null;
  props: string;
  seed: boolean;
}

// ---------------------------------------------------------------- 名字选择
const HAN_RE = /^[\u3400-\u9fff\uf900-\ufaff·・．]+$/;
const KANA_RE = /[\u3040-\u30ff]/;
const TRAD = new Set('國華張陳劉楊黃趙吳孫馬許鄧蕭謝韓馮鄭葉鍾萬範龍東書長門開關寶貴錢鐵銀錦鋒鴻鵬麗愛偉傑強輝榮剛軍紅豔艷飛雲鳳靜蘭蓮曉陽濤濱漢潔滿衛義紀興進達遠運選連農豐學習聯驗權歡劍嶺嶽廣慶懷憲應戰禮祿穎積穩築簡繼續維綱網經緒總縣聲蘇藍詩誠調謀譚貞賀賢賓躍輕遼鄒醫釗鈞鍵鎮閔陸雙雞靈順頌顏願顯騰驛鬱鶴麥齊龔會議區鄉產業團體協員勞動黨'.split(''));
const SIMP = new Set('国华张陈刘杨黄赵吴孙马许邓萧谢韩冯郑叶钟万范龙东书长门开关宝贵钱铁银锦锋鸿鹏丽爱伟杰强辉荣刚军红艳飞云凤静兰莲晓阳涛滨汉洁满卫义纪兴进达远运选连农丰学习联验权欢剑岭岳广庆怀宪应战礼禄颖积稳筑简继续维纲网经绪总县声苏蓝诗诚调谋谭贞贺贤宾跃轻辽邹医钊钧键镇闵陆双鸡灵顺颂颜愿显腾驿郁鹤麦齐龚会议区乡产业团体协员劳动党'.split(''));
const simpScore = (s: string) => [...s].reduce((n, c) => n + (SIMP.has(c) ? 1 : TRAD.has(c) ? -1 : 0), 0);

/** 中国相关实体优先用中文名：大陆取简体，港澳台取繁体 */
export function pickHan(names: string[], countries: string[]): string | undefined {
  const han = [...new Set(names.map((n) => n.trim()))].filter((n) => HAN_RE.test(n) && !KANA_RE.test(n) && n.length >= 2 && n.length <= 40);
  if (!han.length) return undefined;
  const mainland = countries.includes('cn') && !countries.some((c) => c === 'tw' || c === 'hk' || c === 'mo');
  return han.sort((a, b) => (mainland ? simpScore(b) - simpScore(a) : simpScore(a) - simpScore(b)) || a.length - b.length)[0];
}

// ---------------------------------------------------------------- 词表映射
const SECTOR_BY_TOPIC: [string, string][] = [
  ['role.judge', 'judiciary'], ['role.diplo', 'diplomacy'], ['mil', 'military'], ['role.oligarch', 'business'],
  ['role.pep', 'politics'], ['role.pol', 'politics'], ['gov.security', 'security'],
];
function orgType(schema: string, topics: string[]) {
  if (topics.includes('mil')) return 'military';
  if (topics.includes('gov.soe')) return 'soe';
  if (topics.includes('fin.bank')) return 'bank';
  if (topics.includes('fin')) return 'fund';
  if (schema === 'PublicBody') return 'government';
  if (schema === 'Company') return 'company';
  return undefined;
}

/** Family.relationship 描述的是 relative 相对 person 的身份 */
export function familyRel(rel: string, person: string, relative: string): { from: string; to: string; type: string; label?: string } {
  const r = rel.toLowerCase().trim();
  if (/^(spouse|husband|wife)$/.test(r)) return { from: person, to: relative, type: 'spouse' };
  if (/partner/.test(r)) return { from: person, to: relative, type: 'partner', label: r };
  if (/in-law/.test(r) || /^(wife's|husband's)/.test(r)) return { from: person, to: relative, type: 'in-law', label: r };
  if (/^(child|son|daughter)$/.test(r)) return { from: person, to: relative, type: 'parent' };
  if (/^(adopted|step)(child| son| daughter)|^stepchild$|^adopted /.test(r)) return { from: person, to: relative, type: 'parent', label: r };
  if (/^(father|mother|parent)$/.test(r)) return { from: relative, to: person, type: 'parent' };
  if (/^step(parent|father|mother)$|^adoptive (father|mother|parent)$/.test(r)) return { from: relative, to: person, type: 'parent', label: r };
  if (/^(sibling|brother|sister)$/.test(r)) return { from: person, to: relative, type: 'sibling' };
  if (/(brother|sister|sibling)$/.test(r) && !/(father|mother)'s/.test(r)) return { from: person, to: relative, type: 'sibling', label: r };
  return { from: person, to: relative, type: 'relative', label: r || undefined };
}

/**
 * 职位（FtM Position）→ 机构。OpenSanctions 的任职只有职位名、没有机构；为了让只存在于本层的人物也能连进图谱，
 * 每个职位落成一个“职位节点”（机构），同一职位的历任/同届者经由它相连；重要职位直接挂到精编层已有的机构上。
 * [正则, 机构 id, 职位所属国家]
 */
const POST_ORG: [RegExp, string, string][] = [
  [/Politburo Standing Committee/i, 'ccp-politburo-standing-committee', 'cn'],
  [/Politburo/i, 'ccp-politburo', 'cn'],
  [/Secretariat of the .*(Communist Party|CCP)/i, 'ccp-secretariat', 'cn'],
  [/Central Military Commission/i, 'ccp-cmc', 'cn'],
  [/Central Commission for Discipline Inspection/i, 'ccp-ccdi', 'cn'],
  [/Central Committee of the (Chinese Communist Party|Communist Party of China)|CCP Central Committee/i, 'ccp-central-committee', 'cn'],
  [/Standing Committee of the National People/i, 'npc-standing-committee', 'cn'],
  [/National People.?s Congress/i, 'national-people-s-congress', 'cn'],
  [/National Committee of the Chinese People.?s Political Consultative Conference/i, 'cppcc-national-committee', 'cn'],
  [/Premier of the (People.?s Republic of China|State Council)|Vice[- ]Premier|State Councilor|^Premier, State Council/i, 'state-council-prc', 'cn'],
  [/People.?s Bank of China/i, 'pboc', 'cn'],
  [/People.?s Liberation Army/i, 'pla', 'cn'],
  [/United States Senat|U\.S\. Senat/i, 'us-senate', 'us'],
  [/United States House of Representatives|U\.S\. Representative/i, 'us-house', 'us'],
  [/Supreme Court of the United States|Justice of the (United States )?Supreme Court/i, 'us-supreme-court', 'us'],
  [/^(President|Vice President) of the United States/i, 'us-white-house', 'us'],
  [/Federal Reserve/i, 'federal-reserve', 'us'],
];
function postOrgType(topics: string[]) {
  if (topics.includes('gov.legislative')) return 'legislature';
  if (topics.includes('gov.judicial')) return 'court';
  if (topics.includes('pol.party')) return 'party';
  if (topics.includes('gov.soe')) return 'soe';
  return 'government';
}

/** 制裁机构归一：常见机构映射到精编层已有 id，其余按名称建机构 */
const AUTHORITY: [RegExp, string, string, string][] = [
  [/^OFAC$|Office of Foreign Assets Control/i, 'us-treasury-ofac', 'Office of Foreign Assets Control', 'US'],
  [/Bureau of Industry and Security/i, 'us-bis', 'Bureau of Industry and Security', 'US'],
  [/^Department of Defense$/i, 'us-dod', 'United States Department of Defense', 'US'],
  [/Department of Homeland Security/i, 'us-dhs', 'United States Department of Homeland Security', 'US'],
  [/International Trade Administration/i, 'us-ita', 'International Trade Administration', 'US'],
];
const SKIP_AUTHORITY = /debar|development bank|world bank|wbg|insolvency|adb /i;

export const opensanctionsConnector: Connector = {
  id: 'opensanctions',
  description: 'OpenSanctions：中美（含港澳台）政要、亲属关联人、被制裁/反制裁人物与机构及其关系；来自数据仓库',
  async run({ dataDir, log }) {
    const wh = await openWarehouse({ readOnly: true });
    const c = wh.conn;
    let rows: Row[], occ: Record<string, string | null>[], rels: Record<string, string>[], sancs: Record<string, string>[], version = '';
    try {
      version = (await all<{ version: string }>(c, `SELECT version FROM wh_sources WHERE source='opensanctions'`))[0]?.version ?? '';
      log('圈定种子 …');
      await c.run(`CREATE TEMP TABLE sel AS
        SELECT id, true AS seed FROM os_entities WHERE
          (schema = 'Person' AND list_has_any(countries, ${arr([...CN, 'us'])}) AND list_has_any(topics, ${arr(PERSON_TOPICS)}))
          OR (schema IN ${`(${ORG_SCHEMAS.map(lit).join(',')})`} AND list_has_any(countries, ${arr(CN)}) AND list_has_any(topics, ${arr(CN_ORG_TOPICS)}))
          OR (schema IN ${`(${ORG_SCHEMAS.map(lit).join(',')})`} AND list_contains(countries, 'us') AND list_has_any(topics, ${arr(US_ORG_TOPICS)}))`);
      await c.run(`CREATE TEMP TABLE rel AS
        SELECT e.id, e.schema, e.src, e.dst, to_json(o.props) AS props FROM os_edges e JOIN os_entities o USING (id)
        WHERE e.schema IN (${REL_SCHEMAS.map(lit).join(',')}) AND e.dst IS NOT NULL
          AND (e.src IN (SELECT id FROM sel) OR e.dst IN (SELECT id FROM sel))`);
      await c.run(`INSERT INTO sel SELECT DISTINCT x.id, false FROM (SELECT src AS id FROM rel UNION SELECT dst FROM rel) x
        JOIN os_entities o ON o.id = x.id WHERE o.schema IN ('Person', ${ORG_SCHEMAS.map(lit).join(',')}) AND x.id NOT IN (SELECT id FROM sel)`);
      log('读取实体 …');
      rows = await all<Row>(c, `SELECT o.id, o.schema, o.caption, o.countries, o.topics, o.datasets, o.qid, to_json(o.props) AS props, s.seed
        FROM sel s JOIN os_entities o USING (id)`);
      log('读取任职 …');
      occ = await all(c, `SELECT e.src AS holder, e.dst AS post_id, to_json(o.props) AS props, p.caption AS post, to_json(p.props) AS post_props, p.topics AS post_topics, p.countries AS post_countries
        FROM os_edges e JOIN os_entities o USING (id) LEFT JOIN os_entities p ON p.id = e.dst
        WHERE e.schema = 'Occupancy' AND e.src IN (SELECT id FROM sel)`);
      rels = await all(c, `SELECT * FROM rel WHERE src IN (SELECT id FROM sel) AND dst IN (SELECT id FROM sel)`);
      log('读取制裁 …');
      sancs = await all(c, `SELECT e.src AS entity, to_json(o.props) AS props FROM os_edges e JOIN os_entities o USING (id)
        WHERE e.schema = 'Sanction' AND e.src IN (SELECT id FROM sel)`);
    } finally {
      wh.close();
    }
    log(`实体 ${rows.length}（种子 ${rows.filter((r) => r.seed).length}），任职 ${occ.length}，关系 ${rels.length}，制裁 ${sancs.length}`);

    const ids = new IdAllocator(LAYER, dataDir);
    const idOf = new Map<string, string>();
    const known = new Set<string>();
    const ents = new Map<string, Record<string, unknown>>();
    const relations: Record<string, unknown>[] = [];
    const src = (id: string, caption: string) => ({ url: `https://www.opensanctions.org/entities/${id}/`, title: caption, publisher: PUBLISHER });

    // ---- 任职按人分组（先算，用于层级与状态）
    interface Occ { title: string; from?: string; to?: string; current?: boolean; topics: string[]; postId: string; postEn: string; postZh?: string; postCountries: string[] }
    const occBy = new Map<string, Occ[]>();
    for (const o of occ) {
      const p = JSON.parse(o.props ?? '{}') as Props;
      const pp = JSON.parse(o.post_props ?? '{}') as Props;
      const topics = (o.post_topics as unknown as string[] | null) ?? [];
      const zh = pickHan(pp.name ?? [], pp.country ?? []);
      const title = zh ?? o.post ?? '';
      if (!title) continue;
      const to = p.endDate?.[0];
      const status = p.status?.[0];
      const list = occBy.get(o.holder!) ?? occBy.set(o.holder!, []).get(o.holder!)!;
      list.push({
        ...compact({ title, from: p.startDate?.[0], to, current: status === 'current' ? true : undefined }),
        topics,
        postId: o.post_id!,
        postEn: o.post ?? title,
        postZh: zh,
        postCountries: (o.post_countries as unknown as string[] | null) ?? [],
      });
    }

    // ---- 职位节点（见 POST_ORG 注释）
    const postOrgs = new Map<string, { id: string; mapped: boolean }>();
    const postOrg = (o: Occ) => {
      let hit = postOrgs.get(o.postId);
      if (hit) return hit;
      const m = POST_ORG.find(([re, , cc]) => re.test(o.postEn) && o.postCountries.includes(cc));
      if (m && ids.existing(m[1])) hit = { id: m[1], mapped: true };
      else {
        const name = o.postZh ?? o.postEn;
        const id = ids.resolve({ type: 'org', name, names: compact({ zh: o.postZh, en: o.postEn }) as Record<string, string>, ids: { opensanctions: o.postId } }, { strict: true });
        hit = { id, mapped: ids.known(id) };
        if (!hit.mapped && !ents.has(id)) {
          const t = o.topics;
          ents.set(id, compact({
            id,
            type: 'org',
            name,
            names: compact({ zh: o.postZh, en: o.postEn }),
            orgType: postOrgType(t),
            country: [...new Set(o.postCountries.map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)))],
            sectors: [t.includes('gov.judicial') ? 'judiciary' : t.includes('gov.security') ? 'security' : t.includes('role.diplo') ? 'diplomacy' : 'politics'],
            tier: t.includes('gov.head') ? 3 : t.includes('gov.national') ? 4 : 5,
            summary: '职位节点：同一职位的历任/同届任职者经由此节点相连（来自 OpenSanctions 职位数据）',
            ids: { opensanctions: o.postId },
            tags: ['os-post', ...t.map((x) => `os:${x}`)],
            sources: [src(o.postId, o.postEn)],
          }));
        }
      }
      postOrgs.set(o.postId, hit);
      return hit;
    };

    // ---- 实体
    for (const r of rows) {
      const p = JSON.parse(r.props) as Props;
      const isPerson = r.schema === 'Person';
      const allNames = [...(p.name ?? []), ...(p.alias ?? [])];
      const han = r.countries.some((x) => CN.includes(x)) ? pickHan(allNames, r.countries) : undefined;
      const en = /[a-z]/i.test(r.caption) ? r.caption : (p.name ?? []).find((n) => /^[\x20-\x7e]+$/.test(n));
      const name = han ?? r.caption;
      const born = p.birthDate?.sort()[0];
      const extIds = compact({ wikidata: r.qid ?? undefined, opensanctions: r.id }) as Record<string, string>;
      const id = ids.resolve({ type: isPerson ? 'person' : 'org', name, names: compact({ zh: han, en }) as Record<string, string>, ids: extIds, born }, { strict: true });
      idOf.set(r.id, id);
      const isKnown = ids.known(id);
      if (isKnown) known.add(id);
      const country = [...new Set(r.countries.map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)))];
      const tags = ['opensanctions', ...r.topics.map((t) => `os:${t}`)];
      const sources = [src(r.id, r.caption)];
      const base = { id, type: isPerson ? 'person' : 'org', name, names: compact({ zh: han, en }), ids: extIds, country, tags, sources };
      if (isKnown) {
        // 已有人物/机构：只补 ID、标签、来源（职务以高优先级层为准）；
        // 另把任职连到新建的职位节点（挂到已有机构的不重复添加），使其与本层人物相连
        ents.set(id, compact(base));
        for (const o of occBy.get(r.id) ?? []) {
          const po = postOrg(o);
          if (po.mapped) continue;
          relations.push(compact({ from: id, to: po.id, type: 'position', label: o.title, since: o.from, until: o.to, current: o.current, confidence: 'reported', sources: [`https://www.opensanctions.org/entities/${r.id}/`] }));
        }
        continue;
      }
      if (!isPerson) {
        ents.set(id, compact({
          ...base,
          orgType: orgType(r.schema, r.topics),
          tier: r.seed ? 4 : 5,
          summary: (p.notes ?? p.description ?? p.summary)?.[0]?.slice(0, 300),
          founded: p.incorporationDate?.[0],
          dissolved: p.dissolutionDate?.[0],
          sectors: r.topics.includes('mil') ? ['military'] : r.topics.some((t) => t.startsWith('fin')) ? ['finance'] : ['business'],
          attrs: compact({ os_datasets: r.datasets, jurisdiction: p.jurisdiction }),
        }));
        continue;
      }
      const public_ = r.topics.some((t) => t.startsWith('role.pep') || ['role.pol', 'role.judge', 'role.diplo', 'role.oligarch', 'mil'].includes(t)) || occBy.has(r.id);
      const died = p.deathDate?.sort().at(-1);
      const gender = p.gender?.[0] === 'male' ? 'M' : p.gender?.[0] === 'female' ? 'F' : undefined;
      if (!public_) {
        // 非公众亲属/关联人、被制裁的个人：最小化（姓名、性别、出生年份、国家）
        const rca = r.topics.includes('role.rca') || !r.seed;
        ents.set(id, compact({
          ...base,
          gender,
          born: born?.slice(0, 4),
          died: died?.slice(0, 4),
          sectors: [rca ? 'family' : 'other'],
          tier: 5,
          status: died ? 'deceased' : undefined,
        }));
        continue;
      }
      const occs = (occBy.get(r.id) ?? []).sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''));
      const positions = occs.slice(-40).map((o) => compact({ title: o.title, org: postOrg(o).id, from: o.from, to: o.to, current: o.current }));
      const anyCurrent = occs.some((o) => o.current);
      const rank = (o: { topics: string[]; current?: boolean }) => {
        const t = o.topics;
        const base = t.includes('gov.head') ? 2 : t.includes('gov.national') ? 3 : t.includes('gov.state') || t.includes('gov.igo') ? 4 : 5;
        return Math.min(5, base + (o.current ? 0 : 1));
      };
      const tier = occs.length ? Math.min(...occs.map(rank)) : r.topics.includes('sanction.counter') || r.topics.includes('role.oligarch') ? 4 : 5;
      const sectors = [...new Set(SECTOR_BY_TOPIC.filter(([t]) => r.topics.includes(t) || occs.some((o) => o.topics.includes(t))).map(([, s]) => s))];
      ents.set(id, compact({
        ...base,
        aliases: [...new Set(allNames.filter((n) => n !== name && n !== en && (/^[\x20-\x7e]+$/.test(n) || HAN_RE.test(n)) && !KANA_RE.test(n)))].slice(0, 6),
        gender,
        born,
        died,
        birthplace: p.birthPlace?.[0],
        sectors: sectors.length ? sectors : ['politics'],
        tier,
        status: died ? 'deceased' : anyCurrent ? 'active' : undefined,
        summary: [p.notes?.[0] ?? p.description?.[0], p.classification?.[0]].filter(Boolean).join(' · ').slice(0, 300) || undefined,
        positions,
        attrs: compact({ os_datasets: r.datasets, party: p.political?.slice(0, 3) }),
      }));
    }

    // ---- 关系
    const relSrc = (row: Record<string, string>, p: Props) => [...(p.sourceUrl ?? []).slice(0, 1), `https://www.opensanctions.org/entities/${row.id}/`];
    let famN = 0;
    for (const row of rels) {
      const a = idOf.get(row.src), b = idOf.get(row.dst);
      if (!a || !b || a === b) continue;
      const p = JSON.parse(row.props) as Props;
      const since = p.startDate?.[0], until = p.endDate?.[0];
      const base = { confidence: 'reported', sources: relSrc(row, p), since, until };
      switch (row.schema) {
        case 'Family':
          relations.push(compact({ ...base, ...familyRel(p.relationship?.[0] ?? '', a, b) }));
          famN++;
          break;
        case 'Associate':
          relations.push(compact({ ...base, from: a, to: b, type: 'associate', label: p.relationship?.[0] }));
          break;
        case 'Ownership':
          relations.push(compact({ ...base, from: a, to: b, type: 'owner', label: p.percentage?.[0] ? `${p.percentage[0]}%` : p.role?.[0] }));
          break;
        case 'Directorship':
          relations.push(compact({ ...base, from: a, to: b, type: ents.get(a)?.type === 'person' ? 'board' : 'related', label: p.role?.[0] ?? 'director' }));
          break;
        case 'Employment':
          relations.push(compact({ ...base, from: a, to: b, type: ents.get(a)?.type === 'person' && ents.get(b)?.type === 'org' ? 'position' : 'related', label: p.role?.[0] ?? 'employment' }));
          break;
        case 'Membership':
          relations.push(compact({ ...base, from: a, to: b, type: 'member', label: p.role?.[0] }));
          break;
        case 'Representation':
          relations.push(compact({ ...base, from: a, to: b, type: 'client', label: p.role?.[0] }));
          break;
        default:
          relations.push(compact({ ...base, from: a, to: b, type: 'related', label: p.role?.[0] ?? 'link' }));
      }
    }

    // ---- 制裁 → legal（from = 制裁机构）
    const authorities = new Map<string, string>();
    let sancN = 0;
    for (const s of sancs) {
      const target = idOf.get(s.entity);
      if (!target) continue;
      const p = JSON.parse(s.props) as Props;
      const auth = p.authority?.[0]?.trim();
      const program = p.program?.[0] ?? p.programId?.[0];
      if (!auth || SKIP_AUTHORITY.test(auth) || SKIP_AUTHORITY.test(program ?? '')) continue;
      const country = (p.country?.[0] ?? '').toUpperCase();
      const key = `${auth}|${country}`;
      let aid = authorities.get(key);
      if (!aid) {
        const hit = AUTHORITY.find(([re]) => re.test(auth));
        const fixed = hit?.[1] ?? (/^Ministry of Foreign Affairs/i.test(auth) && country === 'CN' ? 'prc-mfa' : undefined);
        const name = hit?.[2] ?? (country ? `${auth}（${country}）` : auth);
        aid = fixed ?? ids.resolve({ type: 'org', name, names: { en: hit?.[2] ?? auth } });
        authorities.set(key, aid);
        if (!ents.has(aid) && !ids.known(aid))
          ents.set(aid, compact({ id: aid, type: 'org', name, names: { en: hit?.[2] ?? auth }, orgType: 'government', country: country ? [country] : undefined, sectors: ['politics'], tier: 4, tags: ['sanctioning-body'], sources: [{ url: 'https://www.opensanctions.org/', title: 'OpenSanctions', publisher: PUBLISHER }] }));
      }
      const since = (p.startDate ?? p.listingDate)?.[0];
      relations.push(compact({
        from: aid,
        to: target,
        type: 'legal',
        label: ['制裁', program, p.reason?.[0]?.slice(0, 120)].filter(Boolean).join('：'),
        since,
        until: p.endDate?.[0],
        confidence: 'confirmed',
        sources: [...(p.sourceUrl ?? []).slice(0, 1), `https://www.opensanctions.org/entities/${s.entity}/`],
      }));
      sancN++;
    }
    // 制裁关系去重（同一机构、同一对象、同一项目可能被多个名单重复收录）
    const seen = new Set<string>();
    const dedup = relations.filter((r) => {
      const k = `${r.from}|${r.type}|${r.to}|${r.label ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const outDir = path.join(dataDir, 'imports', LAYER);
    resetDir(outDir);
    const note = `自动生成：ingest ${LAYER}（${TODAY}，OpenSanctions 版本 ${version}）。许可 CC BY-NC 4.0，须署名、不得商用。请勿手改。`;
    const entities = [...ents.values()];
    writeShards(outDir, 'entities', entities, note);
    writeShards(outDir, 'relations', dedup, note);
    const persons = entities.filter((e) => e.type === 'person').length;
    log(`opensanctions：实体 ${entities.length}（人物 ${persons}，机构 ${entities.length - persons}；其中补充已有实体 ${known.size}），` +
      `关系 ${dedup.length}（家族 ${famN}，制裁 ${sancN}，制裁机构 ${new Set(authorities.values()).size}）`);
  },
};
