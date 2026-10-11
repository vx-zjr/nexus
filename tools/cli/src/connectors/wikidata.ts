/**
 * Wikidata 连接器：按“职位/财富”圈定中美权贵（种子），再自动扩展其一度亲属与关联机构。
 *
 * 圈定策略借鉴 zhao 项目的“按代际/军衔分组”，推广为可配置的预设（preset）：
 *   cn-leaders     总书记/国家主席/总理/常委/政治局委员/军委/书记处/中央部门首长（1990 年后在任）
 *   cn-provincial  省级党委书记（2000 年后在任）
 *   cn-ministers   国务院部长（2003 年后在任）
 *   cn-military    解放军/武警 上将、中将
 *   cn-business    中国（含港澳）企业家/投资人（维基语言版本数≥6 或身家≥10 亿美元）
 *   us-executive   总统/副总统/内阁/白宫幕僚长/国安顾问/美联储主席（1989 年后）
 *   us-congress    参议员（2019 年后在任）、众议员（2023 年后在任）、议长与两党领袖
 *   us-judiciary   最高法院大法官（2000 年后在任）
 *   us-governors   州长（2019 年后在任）
 *   us-business    美国企业家/投资人（身家≥20 亿美元 或 维基语言版本数≥25）
 *
 * 用法：
 *   npm run ctos -- ingest wikidata --preset all
 *   npm run ctos -- ingest wikidata --preset cn-leaders,us-executive
 *   npm run ctos -- ingest wikidata --qids Q15031,Q22686 [--tier 2 --sector politics]   # 追加指定人物
 *   npm run ctos -- ingest wikidata --refresh            # 用已登记的种子重新抓取
 *
 * 礼貌访问：串行请求 + 退避重试；可用环境变量 NEXUS_USER_AGENT 自定义 UA（建议包含联系方式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CACHE_DIR, writeYaml } from '../lib.ts';
import { IdAllocator, type Connector } from './types.ts';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = process.env.NEXUS_USER_AGENT ?? 'NEXUS-relationship-intel/0.1 (personal OSINT research tool; low-rate sequential queries)';
const LAYER = 'wikidata';
const BATCH = 80;

type Row = Record<string, string>;

interface Preset {
  desc: string;
  sector: string;
  country: string;
  /** SPARQL 片段：必须绑定 ?item 与 ?tier。多个片段分别查询后合并（避免大 UNION 超时） */
  where: string | string[];
}

const LIVE_ERA = '?item wdt:P569 ?_b . FILTER(YEAR(?_b) >= 1910)';
/**
 * 任职时间过滤：任期在 since 之后仍在继续。
 * 没有结束日期的陈述必须有开始日期且不早于 since - maxTerm（避免把缺少限定符的历史人物当成现任）。
 */
const served = (since: number | string, maxTerm = 12) =>
  `OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end }
   FILTER((BOUND(?end) && YEAR(?end) >= ${since}) || (!BOUND(?end) && BOUND(?start) && YEAR(?start) >= ${since} - ${maxTerm}))`;

/** 职位 → 层级 的 VALUES 元组（比 UNION+BIND 快得多，避免查询优化器超时） */
const posTiers = (m: Record<string, number>) => `VALUES (?pos ?tier) { ${Object.entries(m).map(([q, t]) => `(wd:${q} ${t})`).join(' ')} }`;
const BIZ_OCC = 'VALUES ?occ { wd:Q43845 wd:Q131524 wd:Q2961975 wd:Q557880 wd:Q806798 wd:Q484876 }';
/** 知名度分支排除娱乐/体育明星（他们常被标注为“企业家”）；身家分支不受影响 */
const NOT_CELEB = `FILTER NOT EXISTS { ?item wdt:P106 ?ent . VALUES ?ent { wd:Q33999 wd:Q10800557 wd:Q10798782 wd:Q177220 wd:Q488205 wd:Q2252262 wd:Q639669 wd:Q4610556 wd:Q947873 wd:Q2045208 wd:Q2066131 wd:Q3665646 wd:Q937857 wd:Q19204627 wd:Q11338576 wd:Q11303721 wd:Q10833314 wd:Q183945 wd:Q245068 wd:Q17125263 wd:Q2906862 wd:Q2526255 } }`;
const BORN_1925 = '?item wdt:P569 ?_b . FILTER(YEAR(?_b) >= 1925)';

export const PRESETS: Record<string, Preset> = {
  'cn-leaders': {
    desc: '中共/国家最高层（1990 年后在任）',
    sector: 'politics',
    country: 'CN',
    where: `${posTiers({
      Q849418: 1, Q655407: 1, Q4122271: 1, Q42327067: 1, Q3408540: 1, Q3400466: 1, Q20792347: 1, Q20792297: 1,
      Q20046316: 2, Q553169: 2, Q508368: 2, Q835630: 2, Q46404263: 2, Q20791672: 2, Q22098497: 2, Q7444412: 2, Q15951289: 2,
      Q17279730: 2, Q17279729: 2, Q42348336: 2, Q51099735: 2, Q2664362: 2, Q6866288: 2, Q20787785: 2, Q10301264: 2, Q4195418: 2, Q4116298: 2,
    })}
      ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(1990)} ${LIVE_ERA}`,
  },
  'cn-provincial': {
    desc: '省级党委书记（2000 年后在任）',
    sector: 'politics',
    country: 'CN',
    where: `VALUES ?cls { wd:Q30067901 wd:Q15921367 } ?pos wdt:P279 ?cls . BIND(3 AS ?tier)
      ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(2000)} ${LIVE_ERA}`,
  },
  'cn-ministers': {
    desc: '国务院部长（2003 年后在任）',
    sector: 'politics',
    country: 'CN',
    where: `?pos wdt:P279 wd:Q83307 ; wdt:P1001 wd:Q148 . BIND(3 AS ?tier)
      ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(2003)} ${LIVE_ERA}`,
  },
  'cn-military': {
    desc: '解放军/武警 上将、中将',
    sector: 'military',
    country: 'CN',
    where: `VALUES (?rank ?tier) { (wd:Q10872929 2) (wd:Q10872992 2) (wd:Q10941686 2) (wd:Q46187421 2) (wd:Q10872930 4) (wd:Q11059719 4) (wd:Q11059191 4) }
      ?item wdt:P410 ?rank ; wdt:P27 wd:Q148 . ?item wdt:P569 ?_b . FILTER(YEAR(?_b) >= 1935)`,
  },
  'cn-business': {
    desc: '中国（含港澳）企业家/投资人',
    sector: 'business',
    country: 'CN',
    where: [
      `VALUES ?c { wd:Q148 wd:Q8646 wd:Q14773 } ${BIZ_OCC}
       ?item wdt:P106 ?occ . ?item wdt:P27 ?c . ?item wikibase:sitelinks ?sl . FILTER(?sl >= 6) BIND(IF(?sl >= 30, 2, IF(?sl >= 15, 3, 4)) AS ?tier) ${NOT_CELEB} ${BORN_1925}`,
      `VALUES ?c { wd:Q148 wd:Q8646 wd:Q14773 } ?item wdt:P27 ?c . ?item p:P2218/psv:P2218/wikibase:quantityAmount ?amt . FILTER(?amt >= 1000000000)
       BIND(4 AS ?tier) ${BORN_1925}`,
    ],
  },
  'us-executive': {
    desc: '美国行政当局核心（1989 年后）',
    sector: 'politics',
    country: 'US',
    where: [
      `${posTiers({ Q11696: 1, Q11699: 1, Q786242: 2, Q1414246: 2, Q2666591: 2 })} ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(1989)} ${LIVE_ERA}`,
      `?pos wdt:P361 wd:Q639738 . BIND(2 AS ?tier) ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(1989)} ${LIVE_ERA}`,
    ],
  },
  'us-congress': {
    desc: '国会：参议员(2019+)、众议员(2023+)、议长与领袖',
    sector: 'politics',
    country: 'US',
    where: [
      `${posTiers({ Q912994: 2, Q28530268: 2 })} ?item p:P39 ?st . ?st ps:P39 ?pos ; pq:P580 ?start . FILTER(YEAR(?start) >= 2003)`,
      `VALUES (?pos ?tier) { (wd:Q4416090 3) } ?item p:P39 ?st . ?st ps:P39 ?pos ; pq:P580 ?start . FILTER(YEAR(?start) >= 2013)
       OPTIONAL { ?st pq:P582 ?end } FILTER(!BOUND(?end) || YEAR(?end) >= 2019)`,
      `VALUES (?pos ?tier) { (wd:Q13218630 4) } ?item p:P39 ?st . ?st ps:P39 ?pos ; pq:P580 ?start . FILTER(YEAR(?start) >= 2021)`,
    ],
  },
  'us-judiciary': {
    desc: '最高法院大法官（2000 年后在任）',
    sector: 'judiciary',
    country: 'US',
    where: `${posTiers({ Q11147: 1, Q11144: 2 })} ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(2000, 40)} ${LIVE_ERA}`,
  },
  'us-governors': {
    desc: '州长（2019 年后在任）',
    sector: 'politics',
    country: 'US',
    where: `?pos wdt:P31 wd:Q889821 ; wdt:P1001 ?state . ?state wdt:P31 wd:Q35657 . BIND(3 AS ?tier)
      ?item p:P39 ?st . ?st ps:P39 ?pos . ${served(2019)} ${LIVE_ERA}`,
  },
  'us-business': {
    desc: '美国企业家/投资人（身家≥20 亿美元 或 知名度高）',
    sector: 'business',
    country: 'US',
    where: [
      `?item wdt:P27 wd:Q30 . ?item p:P2218/psv:P2218/wikibase:quantityAmount ?amt . FILTER(?amt >= 2000000000)
       BIND(4 AS ?tier) ${BORN_1925}`,
      `${BIZ_OCC} ?item wdt:P106 ?occ . ?item wdt:P27 wd:Q30 . ?item wikibase:sitelinks ?sl . FILTER(?sl >= 25) BIND(IF(?sl >= 60, 3, 4) AS ?tier) ${NOT_CELEB} ${BORN_1925}`,
    ],
  },
};

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

/** 查询结果磁盘缓存：中断后重跑会跳过已完成的批次（断点续传）。--fresh 或 NEXUS_WD_FRESH=1 可绕过 */
const QCACHE = path.join(CACHE_DIR, 'wikidata-queries');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
let bypassCache = process.env.NEXUS_WD_FRESH === '1';

export async function sparql(query: string, tries = 8): Promise<Row[]> {
  const key = createHash('sha1').update(query).digest('hex');
  const cf = path.join(QCACHE, key.slice(0, 2), `${key}.json`);
  if (!bypassCache) {
    try {
      const st = fs.statSync(cf);
      if (Date.now() - st.mtimeMs < CACHE_TTL_MS) return JSON.parse(fs.readFileSync(cf, 'utf8')) as Row[];
    } catch {
      /* 未缓存 */
    }
  }
  const rows = await sparqlRemote(query, tries);
  fs.mkdirSync(path.dirname(cf), { recursive: true });
  fs.writeFileSync(cf, JSON.stringify(rows));
  return rows;
}

async function sparqlRemote(query: string, tries: number): Promise<Row[]> {
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, lastCall + 1100 - Date.now());
    if (wait) await sleep(wait);
    lastCall = Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json', 'User-Agent': UA },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(95_000),
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        console.error(`  … SPARQL ${res.status}，${Math.max(ra, 2 * 2 ** i)}s 后重试`);
        await sleep(Math.max(ra * 1000, 2000 * 2 ** i));
        continue;
      }
      if (res.status === 400) throw Object.assign(new Error(`SPARQL 400（查询语法错误，不再重试）: ${(await res.text()).slice(0, 200)}`), { fatal: true });
      if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { results: { bindings: Record<string, { value: string }>[] } };
      return json.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value.replace('http://www.wikidata.org/entity/', '')])));
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      console.error(`  … SPARQL 请求失败（${(e as Error).message.slice(0, 80)}），重试 ${i + 1}/${tries}`);
      if (i === tries - 1) throw e;
      await sleep(Math.min(120_000, 5000 * 2 ** i));
    }
  }
  return [];
}

const values = (qids: string[]) => `VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} }`;
const chunks = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const year = (d?: string) => (d ? d.slice(0, 10).replace(/^\+/, '').replace(/-01-01$/, '').replace(/T.*$/, '') : undefined);
/** Wikidata 日期精度不可见时，只保留到“年-月-日”；1月1日多为“仅年份”精度 */
const fuzzy = (d?: string) => {
  // “未知值”会以 genid IRI 形式返回，只接受真正的日期
  if (!d || !/^[+-]?\d{1,4}-\d{2}-\d{2}/.test(d)) return undefined;
  const y = year(d);
  if (!y) return undefined;
  return y.length === 10 && y.endsWith('-01-01') ? y.slice(0, 4) : y;
};

const ZH_PREF = ['zh-cn', 'zh-hans', 'zh', 'zh-sg', 'zh-my', 'zh-hk', 'zh-tw', 'zh-hant', 'zh-mo'];

interface Info {
  qid: string;
  en?: string;
  zh?: string;
  descEn?: string;
  descZh?: string;
  born?: string;
  died?: string;
  gender?: 'M' | 'F' | 'X';
  countries: Set<string>;
  occupations: Set<string>;
  netWorth?: number;
  sitelinks: number;
  enwiki?: string;
  zhwiki?: string;
  isHuman?: boolean;
  instanceOf: Set<string>;
  party?: string;
}

function newInfo(qid: string): Info {
  return { qid, countries: new Set(), occupations: new Set(), sitelinks: 0, instanceOf: new Set() };
}

/**
 * 按实体缓存：每个 QID 每类查询的结果单独缓存（.cache/wikidata-entities/<kind>/）。
 * 只对缺失的 QID 发起批量查询；批次构成与查询文本保持不变，因此也能命中旧的整批查询缓存。
 */
const ECACHE = path.join(CACHE_DIR, 'wikidata-entities');
async function cachedRows(kind: string, qids: string[], query: (V: string) => string, onBatch?: (i: number, n: number) => void): Promise<Row[]> {
  const out: Row[] = [];
  const missing: string[] = [];
  const fileOf = (q: string) => path.join(ECACHE, kind, q.slice(-2), `${q}.json`);
  for (const q of qids) {
    if (!bypassCache) {
      try {
        const f = fileOf(q);
        if (Date.now() - fs.statSync(f).mtimeMs < CACHE_TTL_MS) {
          out.push(...(JSON.parse(fs.readFileSync(f, 'utf8')) as Row[]));
          continue;
        }
      } catch {
        /* 未缓存 */
      }
    }
    missing.push(q);
  }
  const batches = chunks(missing, BATCH);
  for (const [bi, b] of batches.entries()) {
    onBatch?.(bi + 1, batches.length);
    const rows = await sparql(query(values(b)));
    const by = new Map<string, Row[]>(b.map((q) => [q, []]));
    for (const r of rows) by.get(r.item)?.push(r);
    for (const [q, rs] of by) {
      const f = fileOf(q);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(rs));
    }
    out.push(...rows);
  }
  return out;
}

async function fetchInfo(qids: string[], log: (m: string) => void, label: string): Promise<Map<string, Info>> {
  const out = new Map<string, Info>();
  const get = (q: string) => out.get(q) ?? out.set(q, newInfo(q)).get(q)!;
  for (const q of qids) get(q);
  const progress = (i: number, n: number) => log(`  [${label}] 基本信息 批次 ${i}/${n}`);
  for (const r of await cachedRows('labels', qids, (V) => `SELECT ?item ?l ?lang WHERE { ${V} ?item rdfs:label ?l . BIND(LANG(?l) AS ?lang) FILTER(?lang IN ("en","mul","${ZH_PREF.join('","')}")) }`, progress)) {
    const i = get(r.item);
    if (r.lang === 'en') i.en = r.l;
    // Wikidata 的 mul（多语言默认）标签：英文标签缺失时作为英文名
    else if (r.lang === 'mul') i.en ??= r.l;
    else if (!i.zh || ZH_PREF.indexOf(r.lang) < ZH_PREF.indexOf((i as unknown as { _zl: string })._zl ?? 'zh-mo')) {
      i.zh = r.l;
      (i as unknown as { _zl: string })._zl = r.lang;
    }
  }
  for (const i of out.values()) if (i.en === undefined) delete i.en; // mul 回退后清理
  for (const r of await cachedRows('desc', qids, (V) => `SELECT ?item ?d ?lang WHERE { ${V} ?item schema:description ?d . BIND(LANG(?d) AS ?lang) FILTER(?lang IN ("en","zh","zh-cn","zh-hans")) }`)) {
    const i = get(r.item);
    if (r.lang === 'en') i.descEn = r.d;
    else i.descZh ??= r.d;
  }
  for (const r of await cachedRows('facts', qids, (V) => `SELECT ?item ?b ?d ?g ?sl ?inst WHERE { ${V} OPTIONAL { ?item wdt:P569 ?b } OPTIONAL { ?item wdt:P570 ?d } OPTIONAL { ?item wdt:P21 ?g } OPTIONAL { ?item wikibase:sitelinks ?sl } OPTIONAL { ?item wdt:P31 ?inst } }`)) {
    const i = get(r.item);
    if (r.b && !i.born) i.born = fuzzy(r.b);
    if (r.d && !i.died) i.died = fuzzy(r.d);
    if (r.g) i.gender = r.g === 'Q6581097' || r.g === 'Q2449503' ? 'M' : r.g === 'Q6581072' || r.g === 'Q1052281' ? 'F' : 'X';
    if (r.sl) i.sitelinks = Number(r.sl);
    if (r.inst) i.instanceOf.add(r.inst);
    if (r.inst === 'Q5') i.isHuman = true;
  }
  for (const r of await cachedRows('countries', qids, (V) => `SELECT ?item ?iso ?c WHERE { ${V} { ?item wdt:P27 ?c } UNION { ?item wdt:P17 ?c } OPTIONAL { ?c wdt:P297 ?iso } }`)) {
    const iso = r.iso ?? COUNTRY_FALLBACK[r.c];
    if (iso) get(r.item).countries.add(iso.toUpperCase());
  }
  for (const r of await cachedRows('occupations', qids, (V) => `SELECT ?item ?occ WHERE { ${V} ?item wdt:P106 ?occ }`)) get(r.item).occupations.add(r.occ);
  for (const r of await cachedRows('networth', qids, (V) => `SELECT ?item (MAX(?amt) AS ?nw) WHERE { ${V} ?item p:P2218/psv:P2218 [ wikibase:quantityAmount ?amt ; wikibase:quantityUnit wd:Q4917 ] } GROUP BY ?item`)) {
    get(r.item).netWorth = Number(r.nw);
  }
  for (const r of await cachedRows('sitelinks', qids, (V) => `SELECT ?item ?site ?t WHERE { ${V} ?a schema:about ?item ; schema:isPartOf ?site ; schema:name ?t . FILTER(?site IN (<https://en.wikipedia.org/>, <https://zh.wikipedia.org/>)) }`)) {
    const i = get(r.item);
    if (r.site.includes('en.')) i.enwiki = r.t;
    else i.zhwiki = r.t;
  }
  for (const r of await cachedRows('party', qids, (V) => `SELECT ?item ?pl WHERE { ${V} ?item wdt:P102 ?p . ?p rdfs:label ?pl FILTER(LANG(?pl)="en") }`)) get(r.item).party ??= r.pl;
  return out;
}

const COUNTRY_FALLBACK: Record<string, string> = {
  Q148: 'CN', Q29520: 'CN', Q13426199: 'CN', Q8646: 'HK', Q14773: 'MO', Q865: 'TW', Q30: 'US', Q145: 'GB', Q15180: 'RU', Q34266: 'RU',
};

const OCC_SECTOR: Record<string, string> = {
  Q82955: 'politics', Q193391: 'diplomacy', Q43845: 'business', Q131524: 'business', Q2961975: 'business', Q484876: 'business',
  Q806798: 'finance', Q557880: 'finance', Q1979607: 'finance', Q188094: 'academia', Q189290: 'military', Q47064: 'military',
  Q4991371: 'military', Q16533: 'judiciary', Q40348: 'judiciary', Q1930187: 'media', Q578109: 'media', Q1622272: 'academia',
  Q901: 'academia', Q1650915: 'academia', Q33999: 'culture', Q177220: 'culture', Q36180: 'culture', Q483501: 'culture',
  Q82594: 'tech', Q81096: 'tech', Q5482740: 'tech', Q2066131: 'sports', Q250867: 'religion', Q2259532: 'media', Q11774891: 'sports',
};

/** 机构类型：按 P31 粗分 */
const ORG_TYPE_BY_CLASS: Record<string, string> = {
  Q3918: 'university', Q875538: 'university', Q902104: 'university', Q15936437: 'university', Q23002054: 'university', Q38723: 'university',
  Q7278: 'party', Q4830453: 'company', Q783794: 'company', Q891723: 'company', Q6881511: 'company', Q1589009: 'company', Q219577: 'company',
  Q270791: 'soe', Q22687: 'bank', Q848507: 'bank', Q66344: 'bank', Q327333: 'government', Q2659904: 'government', Q192350: 'government',
  Q11204: 'legislature', Q1752346: 'legislature', Q41487: 'court', Q190752: 'court', Q484652: 'ngo', Q157031: 'foundation',
  Q163740: 'ngo', Q1331793: 'media', Q11032: 'media', Q1110794: 'media', Q15265344: 'media', Q1002697: 'media', Q1371037: 'think-tank',
  Q176799: 'military', Q8473: 'military', Q4671277: 'fund', Q5161088: 'fund', Q11691: 'ngo', Q9826: 'school', Q3914: 'school',
};

interface FamilyRow {
  item: string;
  rel: string;
  t: string;
  s?: string;
  e?: string;
  endCause?: string;
  kinZh?: string;
  kinEn?: string;
}

async function fetchFamily(qids: string[], log: (m: string) => void): Promise<FamilyRow[]> {
  const rows = await cachedRows('family', qids, (V) => `SELECT ?item ?rel ?t ?s ?e ?endCause ?kinZh ?kinEn WHERE { ${V}
      { ?item p:P26 ?st . ?st ps:P26 ?rel . BIND("spouse" AS ?t) OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } OPTIONAL { ?st pq:P1534 ?endCause } }
      UNION { ?item wdt:P22 ?rel . BIND("father" AS ?t) }
      UNION { ?item wdt:P25 ?rel . BIND("mother" AS ?t) }
      UNION { ?item wdt:P40 ?rel . BIND("child" AS ?t) }
      UNION { ?item wdt:P3373 ?rel . BIND("sibling" AS ?t) }
      UNION { ?item wdt:P451 ?rel . BIND("partner" AS ?t) }
      UNION { ?item p:P1038 ?st . ?st ps:P1038 ?rel . BIND("relative" AS ?t)
              OPTIONAL { ?st pq:P1039 ?kin . OPTIONAL { ?kin rdfs:label ?kinZh FILTER(LANG(?kinZh)="zh") } OPTIONAL { ?kin rdfs:label ?kinEn FILTER(LANG(?kinEn)="en") } } }
      FILTER(isIRI(?rel)) }`, (i, n) => log(`  [family] 亲属关系 批次 ${i}/${n}`));
  // 只保留真实实体（排除“未知值” genid 等）
  return (rows as unknown as FamilyRow[]).filter((r) => /^Q\d+$/.test(r.rel));
}

interface PosRow {
  item: string;
  pos: string;
  posEn?: string;
  posZh?: string;
  start?: string;
  end?: string;
  org?: string;
}

async function fetchPositions(qids: string[], log: (m: string) => void): Promise<PosRow[]> {
  return (await cachedRows('positions', qids, (V) => `SELECT ?item ?pos ?posEn ?posZh ?start ?end ?org WHERE { ${V} ?item p:P39 ?st . ?st ps:P39 ?pos .
        OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end }
        OPTIONAL { ?pos rdfs:label ?posEn FILTER(LANG(?posEn)="en") }
        OPTIONAL { ?pos rdfs:label ?posZh FILTER(LANG(?posZh) IN ("zh-cn","zh-hans","zh")) }
        OPTIONAL { ?pos wdt:P2389 ?org1 } OPTIONAL { ?pos wdt:P361 ?org2 } BIND(COALESCE(?org1, ?org2) AS ?org) }`, (i, n) => log(`  [positions] 职务 批次 ${i}/${n}`))) as unknown as PosRow[];
}

interface AffRow {
  item: string;
  org: string;
  t: string;
  l?: string;
  s?: string;
  e?: string;
}

async function fetchAffiliations(qids: string[], log: (m: string) => void): Promise<AffRow[]> {
  return (await cachedRows('affiliations', qids, (V) => `SELECT ?item ?org ?t ?l ?s ?e WHERE { ${V}
        { ?item p:P69 ?st . ?st ps:P69 ?org . BIND("alumni" AS ?t) OPTIONAL { ?st pq:P512 ?deg . ?deg rdfs:label ?l FILTER(LANG(?l)="en") } OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } }
        UNION { ?item p:P108 ?st . ?st ps:P108 ?org . BIND("employer" AS ?t) OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } }
        UNION { ?item wdt:P1830 ?org . BIND("owner" AS ?t) }
        UNION { ?org wdt:P169 ?item . BIND("ceo" AS ?t) }
        UNION { ?org wdt:P488 ?item . BIND("chair" AS ?t) }
        UNION { ?org wdt:P112 ?item . BIND("founder" AS ?t) }
        UNION { ?org wdt:P127 ?item . BIND("owner" AS ?t) }
        UNION { ?org wdt:P3320 ?item . BIND("board" AS ?t) }
        FILTER(isIRI(?org)) }`, (i, n) => log(`  [affiliations] 教育/任职/持股 批次 ${i}/${n}`))) as unknown as AffRow[];
}

/** 实体检索：按名字查 Wikidata QID（供 `ctos wd <名字>` 使用） */
export async function searchEntities(text: string, lang = /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en', limit = 8) {
  const q = text.replace(/"/g, '');
  return sparql(`SELECT ?item ?itemLabel ?d ?b WHERE {
    SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch"; mwapi:search "${q}"; mwapi:language "${lang}". ?item wikibase:apiOutputItem mwapi:item. ?num wikibase:apiOrdinal true. }
    FILTER(?num < ${limit}) OPTIONAL { ?item schema:description ?d FILTER(LANG(?d) = "en") } OPTIONAL { ?item wdt:P569 ?b }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en". } } ORDER BY ?num`);
}

/** 维基百科分类成员 → Wikidata QID（用于 Wikidata 中缺少成员关系的群体，如“第二十届中央委员”） */
export async function categoryQids(lang: string, category: string, log: (m: string) => void): Promise<string[]> {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const get = async (params: Record<string, string>) => {
    for (let i = 0; i < 6; i++) {
      const wait = Math.max(0, lastCall + 1100 - Date.now());
      if (wait) await sleep(wait);
      lastCall = Date.now();
      try {
        const res = await fetch(`${api}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
        if (res.status === 429 || res.status >= 500) {
          await sleep((Number(res.headers.get('retry-after')) || 5 * 2 ** i) * 1000);
          continue;
        }
        return (await res.json()) as Record<string, any>;
      } catch {
        await sleep(5000 * 2 ** i);
      }
    }
    throw new Error(`维基百科 API 请求失败：${category}`);
  };
  const titles: string[] = [];
  let cont: string | undefined;
  do {
    const d = await get({ action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmnamespace: '0', cmlimit: '500', ...(cont ? { cmcontinue: cont } : {}) });
    titles.push(...(d.query?.categorymembers ?? []).map((m: { title: string }) => m.title));
    cont = d.continue?.cmcontinue;
  } while (cont);
  const qids: string[] = [];
  for (const batch of chunks(titles, 50)) {
    const d = await get({ action: 'query', prop: 'pageprops', ppprop: 'wikibase_item', titles: batch.join('|'), redirects: '1' });
    for (const pg of Object.values(d.query?.pages ?? {}) as { pageprops?: { wikibase_item?: string } }[]) {
      if (pg.pageprops?.wikibase_item) qids.push(pg.pageprops.wikibase_item);
    }
  }
  log(`维基分类 ${lang}:${category}：${titles.length} 个条目 → ${qids.length} 个 QID`);
  return qids;
}

interface Manifest {
  updated?: string;
  presets: string[];
  seeds: Record<string, { tier: number; sector: string; country: string; via: string[] }>;
}

export const wikidataConnector: Connector = {
  id: 'wikidata',
  description: `Wikidata 批量采集（预设：${Object.keys(PRESETS).join(', ')}；或 --qids 指定）`,
  async run({ args, dataDir, log }) {
    const arg = (k: string) => {
      const i = args.indexOf(k);
      return i >= 0 ? args[i + 1] : undefined;
    };
    if (args.includes('--fresh')) bypassCache = true;
    const outDir = path.join(dataDir, 'imports', LAYER);
    const manifestFile = path.join(outDir, '_manifest.json');
    const manifest: Manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { presets: [], seeds: {} };

    // ---- 1. 圈定种子 ----
    const presetArg = arg('--preset');
    const presets = presetArg === 'all' ? Object.keys(PRESETS) : (presetArg?.split(',').filter(Boolean) ?? []);
    for (const p of presets) if (!PRESETS[p]) throw new Error(`未知预设 ${p}。可用：${Object.keys(PRESETS).join(', ')}`);
    const addSeed = (qid: string, tier: number, sector: string, country: string, via: string) => {
      const s = manifest.seeds[qid];
      if (!s) manifest.seeds[qid] = { tier, sector, country, via: [via] };
      else {
        s.tier = Math.min(s.tier, tier);
        if (!s.via.includes(via)) s.via.push(via);
      }
    };
    fs.mkdirSync(outDir, { recursive: true });
    if (args.includes('--reseed')) {
      // 重建指定预设的种子：先移除这些预设带来的种子（仍被其他来源引用的保留）
      let removed = 0;
      for (const [q, sd] of Object.entries(manifest.seeds)) {
        sd.via = sd.via.filter((v) => !presets.includes(v));
        if (!sd.via.length) {
          delete manifest.seeds[q];
          removed++;
        }
      }
      log(`--reseed：移除 ${removed} 个旧种子`);
    }
    for (const p of presets) {
      const pr = PRESETS[p];
      const parts = Array.isArray(pr.where) ? pr.where : [pr.where];
      const found = new Set<string>();
      for (const part of parts) {
        let rows: Row[] = [];
        try {
          rows = await sparql(`SELECT ?item (MIN(?tier) AS ?t) (MAX(?amt) AS ?a) WHERE { ${part} } GROUP BY ?item`);
        } catch (e) {
          log(`  ! 预设 ${p} 的一个子查询失败，已跳过：${(e as Error).message.slice(0, 120)}`);
          continue;
        }
        for (const r of rows) {
          // 身家分层在客户端计算（Blazegraph 对数值 BIND(IF) 有 bug）
          const worth = r.a ? Number(r.a) : 0;
          const tier = worth ? (worth >= 1e11 ? 1 : worth >= 2e10 ? 2 : worth >= 5e9 ? 3 : 4) : Number(r.t);
          addSeed(r.item, Math.min(tier, Number(r.t) || 5), pr.sector, pr.country, p);
          found.add(r.item);
        }
      }
      if (!manifest.presets.includes(p)) manifest.presets.push(p);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
      log(`预设 ${p.padEnd(14)} ${pr.desc}：${found.size} 人`);
    }
    // --wp-category "zh:中国共产党第二十届中央委员会委员" [--tier 3 --sector politics --country CN]，可重复多次
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--wp-category') continue;
      const spec = args[i + 1] ?? '';
      const [lang, ...rest] = spec.includes(':') ? spec.split(':') : ['en', spec];
      const cat = rest.join(':');
      const qs = await categoryQids(lang, cat, log);
      for (const q of qs) addSeed(q, Number(arg('--tier') ?? 3), arg('--sector') ?? 'politics', arg('--country') ?? '', `wpcat:${cat}`);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    }
    const qidArg = arg('--qids');
    if (qidArg) {
      for (const q of qidArg.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^Q\d+$/.test(s))) {
        addSeed(q, Number(arg('--tier') ?? 3), arg('--sector') ?? 'other', arg('--country') ?? '', 'manual');
      }
    }
    const seeds = Object.keys(manifest.seeds);
    if (!seeds.length) {
      log('没有种子。请使用 --preset all 或 --qids Q123,Q456');
      return;
    }
    if (!presets.length && !qidArg && !args.includes('--refresh') && !args.includes('--wp-category')) {
      log('提示：未指定 --preset/--qids，将以已登记的种子刷新。');
    }
    log(`种子总数 ${seeds.length}，开始抓取详情…`);

    // ---- 2. 种子详情 + 亲属 + 职务 + 关联机构 ----
    const info = await fetchInfo(seeds, log, 'seeds');
    const fam = await fetchFamily(seeds, log);
    const seedSet = new Set(seeds);
    const relativeQids = [...new Set(fam.map((f) => f.rel))].filter((q) => !seedSet.has(q));
    log(`一度亲属 ${relativeQids.length} 人，抓取其基本信息…`);
    const relInfo = await fetchInfo(relativeQids, log, 'relatives');
    // 亲属收录门槛：有维基百科条目（知名度）或已故；且必须是人类
    const minYear = new Date().getUTCFullYear() - 18;
    const keptRelatives = relativeQids.filter((q) => {
      const i = relInfo.get(q);
      const by = i?.born ? Number(i.born.slice(0, 4)) : undefined;
      if (i && !i.died && by && by > minYear) return false; // 未成年人不收录
      return i && i.isHuman !== false && (i.sitelinks >= 1 || i.died);
    });
    for (const q of keptRelatives) info.set(q, relInfo.get(q)!);
    const people = [...seedSet, ...keptRelatives].filter((q) => info.get(q)?.isHuman);
    const peopleSet = new Set(people);

    const positions = await fetchPositions(people, log);
    const affs = await fetchAffiliations(seeds, log);

    // ---- 3. 机构：只保留有“网络价值”的 ----
    const orgUse = new Map<string, Set<string>>();
    const strongOrg = new Set<string>();
    for (const p of positions) if (p.org && /^Q\d+$/.test(p.org)) (orgUse.get(p.org) ?? orgUse.set(p.org, new Set()).get(p.org)!).add(p.item);
    for (const a of affs) {
      if (!/^Q\d+$/.test(a.org)) continue;
      (orgUse.get(a.org) ?? orgUse.set(a.org, new Set()).get(a.org)!).add(a.item);
      if (['owner', 'ceo', 'chair', 'founder', 'board'].includes(a.t)) strongOrg.add(a.org);
    }
    const orgQids = [...orgUse.entries()].filter(([q, users]) => !peopleSet.has(q) && (strongOrg.has(q) || users.size >= 2)).map(([q]) => q);
    log(`关联机构 ${orgQids.length} 个，抓取其基本信息…`);
    const orgInfo = await fetchInfo(orgQids, log, 'orgs');
    const orgKeep = new Set(orgQids.filter((q) => !orgInfo.get(q)?.isHuman));

    // ---- 4. 生成 NEXUS 数据 ----
    const ids = new IdAllocator(LAYER, dataDir);
    const idOf = new Map<string, string>();
    const today = new Date().toISOString().slice(0, 10);
    const wd = (q: string) => ({ url: `https://www.wikidata.org/wiki/${q}`, publisher: 'Wikidata', accessed: today });
    const isCN = (i: Info) => [...i.countries].some((c) => ['CN', 'HK', 'MO', 'TW'].includes(c));

    const entities: Record<string, unknown>[] = [];
    for (const q of people) {
      const i = info.get(q)!;
      const seed = manifest.seeds[q];
      const country = i.countries.size ? [...i.countries] : seed?.country ? [seed.country] : [];
      const name = (isCN(i) || (!i.en && i.zh) ? i.zh : i.en) ?? i.zh ?? q;
      const id = ids.resolve({ type: 'person', name, names: { ...(i.zh ? { zh: i.zh } : {}), ...(i.en ? { en: i.en } : {}) }, ids: { wikidata: q }, born: i.born });
      idOf.set(q, id);
      const sectors = new Set<string>();
      if (seed) sectors.add(seed.sector);
      for (const o of i.occupations) if (OCC_SECTOR[o]) sectors.add(OCC_SECTOR[o]);
      if (!sectors.size) sectors.add('family');
      const tier = seed ? seed.tier : i.sitelinks >= 30 ? 3 : i.sitelinks >= 10 ? 4 : 5;
      const links = [i.zhwiki && `https://zh.wikipedia.org/wiki/${encodeURIComponent(i.zhwiki.replace(/ /g, '_'))}`, i.enwiki && `https://en.wikipedia.org/wiki/${encodeURIComponent(i.enwiki.replace(/ /g, '_'))}`].filter(Boolean);
      entities.push({
        id,
        type: 'person',
        name,
        names: { ...(i.zh ? { zh: i.zh } : {}), ...(i.en ? { en: i.en } : {}) },
        ...(i.gender ? { gender: i.gender } : {}),
        ...(i.born ? { born: i.born } : {}),
        ...(i.died ? { died: i.died } : {}),
        country,
        sectors: [...sectors].slice(0, 3),
        tier,
        summary: i.descZh ?? i.descEn,
        ...(i.netWorth ? { netWorth: { usd: i.netWorth } } : {}),
        ids: { wikidata: q },
        links,
        tags: [...(seed?.via ?? ['relative']), ...(i.party ? [`party:${i.party}`] : [])],
        ...(i.party ? { attrs: { party: i.party, sitelinks: i.sitelinks } } : { attrs: { sitelinks: i.sitelinks } }),
        sources: [wd(q)],
      });
    }
    for (const q of orgKeep) {
      const i = orgInfo.get(q)!;
      const name = (isCN(i) ? i.zh : i.en) ?? i.zh ?? i.en ?? q;
      const id = ids.resolve({ type: 'org', name, names: { ...(i.zh ? { zh: i.zh } : {}), ...(i.en ? { en: i.en } : {}) }, ids: { wikidata: q } });
      idOf.set(q, id);
      const orgType = [...i.instanceOf].map((c) => ORG_TYPE_BY_CLASS[c]).find(Boolean) ?? 'other';
      const sector = orgType === 'university' || orgType === 'think-tank' ? 'academia' : orgType === 'party' || orgType === 'government' || orgType === 'legislature' ? 'politics' : orgType === 'court' ? 'judiciary' : orgType === 'military' ? 'military' : orgType === 'media' ? 'media' : orgType === 'bank' || orgType === 'fund' ? 'finance' : orgType === 'company' || orgType === 'soe' ? 'business' : 'other';
      entities.push({
        id,
        type: 'org',
        name,
        names: { ...(i.zh ? { zh: i.zh } : {}), ...(i.en ? { en: i.en } : {}) },
        orgType,
        country: [...i.countries],
        sectors: [sector],
        tier: i.sitelinks >= 60 ? 2 : i.sitelinks >= 20 ? 3 : 4,
        summary: i.descZh ?? i.descEn,
        ids: { wikidata: q },
        links: [i.enwiki && `https://en.wikipedia.org/wiki/${encodeURIComponent(i.enwiki.replace(/ /g, '_'))}`].filter(Boolean),
        sources: [wd(q)],
      });
    }

    // 职务：写入人物 positions（带机构则自动派生 position 边）
    const posByPerson = new Map<string, Map<string, Record<string, unknown>>>();
    for (const p of positions) {
      const pid = idOf.get(p.item);
      if (!pid) continue;
      const title = p.posZh ?? p.posEn ?? p.pos;
      const key = `${p.pos}|${p.start ?? ''}`;
      const m = posByPerson.get(p.item) ?? posByPerson.set(p.item, new Map()).get(p.item)!;
      if (m.has(key)) continue;
      m.set(key, {
        title,
        ...(p.org && orgKeep.has(p.org) ? { org: idOf.get(p.org) } : {}),
        ...(fuzzy(p.start) ? { from: fuzzy(p.start) } : {}),
        ...(p.end ? { to: fuzzy(p.end) } : {}),
      });
    }
    for (const e of entities) {
      const q = (e.ids as Record<string, string>).wikidata;
      const m = posByPerson.get(q);
      if (m?.size) e.positions = [...m.values()];
    }

    // 关系
    const relations: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const addRel = (r: Record<string, unknown>) => {
      const k = `${r.from}|${r.type}|${r.to}|${r.label ?? ''}`;
      const k2 = `${r.to}|${r.type}|${r.from}|${r.label ?? ''}`;
      if (seen.has(k) || seen.has(k2)) return;
      seen.add(k);
      relations.push(r);
    };
    for (const f of fam) {
      const a = idOf.get(f.item), b = idOf.get(f.rel);
      if (!a || !b) continue;
      const ib = info.get(f.rel);
      const src = [wd(f.item)];
      switch (f.t) {
        case 'father':
        case 'mother':
          addRel({ from: b, to: a, type: 'parent', sources: src });
          break;
        case 'child':
          addRel({ from: a, to: b, type: 'parent', label: ib?.gender === 'F' ? '女' : ib?.gender === 'M' ? '子' : undefined, sources: src });
          break;
        case 'spouse': {
          const divorced = f.endCause === 'Q93190';
          addRel({ from: a, to: b, type: divorced ? 'ex-spouse' : 'spouse', ...(fuzzy(f.s) ? { since: fuzzy(f.s) } : {}), ...(divorced && fuzzy(f.e) ? { until: fuzzy(f.e) } : {}), sources: src });
          break;
        }
        case 'sibling':
          addRel({ from: a, to: b, type: 'sibling', sources: src });
          break;
        case 'partner':
          addRel({ from: a, to: b, type: 'partner', sources: src });
          break;
        case 'relative':
          addRel({ from: a, to: b, type: /law|岳|婿|媳|姻/.test(`${f.kinEn ?? ''}${f.kinZh ?? ''}`) ? 'in-law' : 'relative', label: f.kinZh ?? f.kinEn, sources: src });
          break;
      }
    }
    const AFF_LABEL: Record<string, string> = { ceo: 'CEO', chair: '董事长/主席', employer: '任职' };
    for (const a of affs) {
      const p = idOf.get(a.item), o = idOf.get(a.org);
      if (!p || !o || !orgKeep.has(a.org)) continue;
      const src = [wd(a.item)];
      const span = { ...(fuzzy(a.s) ? { since: fuzzy(a.s) } : {}), ...(fuzzy(a.e) ? { until: fuzzy(a.e) } : {}) };
      if (a.t === 'alumni') addRel({ from: p, to: o, type: 'alumni', ...(a.l ? { label: a.l } : {}), ...span, sources: src });
      else if (a.t === 'owner') addRel({ from: p, to: o, type: 'owner', sources: src });
      else if (a.t === 'founder') addRel({ from: p, to: o, type: 'founder', sources: src });
      else if (a.t === 'board') addRel({ from: p, to: o, type: 'board', sources: src });
      else addRel({ from: p, to: o, type: 'position', label: AFF_LABEL[a.t], ...span, sources: src });
    }

    // ---- 5. 写文件（按 id 首字母分片，便于浏览与 diff）----
    fs.rmSync(outDir, { recursive: true, force: true });
    const header = `自动生成：ingest wikidata（${today}）。数据来自 Wikidata（CC0）。\n请勿手工修改——修订请写到 data/curated/ 覆盖；重新导入：npm run ctos -- ingest wikidata --refresh`;
    const shard = (id: string) => (/^[a-z]/.test(id) ? id[0] : '0');
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const e of entities) {
      const k = `${e.type === 'person' ? 'persons' : 'orgs'}/${shard(String(e.id))}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    for (const [k, list] of groups) writeYaml(path.join(outDir, `${k}.yaml`), { entities: list.sort((a, b) => String(a.id).localeCompare(String(b.id))) }, header);
    const relGroups = new Map<string, Record<string, unknown>[]>();
    for (const r of relations) {
      const k = shard(String(r.from));
      (relGroups.get(k) ?? relGroups.set(k, []).get(k)!).push(r);
    }
    for (const [k, list] of relGroups) writeYaml(path.join(outDir, 'relations', `${k}.yaml`), { relations: list }, header);
    manifest.updated = today;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    log(`Wikidata 导入完成：人物 ${people.length}（种子 ${seeds.length}，亲属 ${keptRelatives.length}），机构 ${orgKeep.size}，关系 ${relations.length}`);
  },
};
