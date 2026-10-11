import { pinyin } from 'pinyin-pro';
import type { Source } from './types.ts';
import type { SourceInput } from './schema.ts';

const CJK_RE = /[㐀-鿿豈-﫿]/;
const COMPOUND_SURNAMES = new Set([
  '欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '长孙', '宇文', '司徒', '夏侯', '令狐', '端木', '独孤', '南宫', '万俟', '闻人', '轩辕',
]);

export function hasCJK(s: string): boolean {
  return CJK_RE.test(s);
}

/** 中文姓名转拼音数组（按姓氏读音规则），非中文字符原样保留 */
export function namePinyin(name: string): string[] {
  return pinyin(name, { toneType: 'none', type: 'array', surname: 'head', nonZh: 'removed', v: true }) as string[];
}

function asciiSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * 生成稳定 id：
 *   英文名 "Xi Jinping" → xi-jinping
 *   中文名 "习近平"     → xi-jinping（姓-名）
 *   "欧阳中石"          → ouyang-zhongshi
 */
export function slugify(name: string, kind: 'person' | 'org' = 'person'): string {
  const clean = name.replace(/[（(].*?[)）]/g, '').trim();
  if (hasCJK(clean) && kind === 'org') {
    return clean
      .split(/[·・\s]+/)
      .map((part) => (hasCJK(part) ? namePinyin(part).join('-') : asciiSlug(part)))
      .filter(Boolean)
      .join('-')
      .replace(/-+/g, '-')
      .slice(0, 80);
  }
  if (hasCJK(clean)) {
    const parts = clean.split(/[·・\s]+/).filter(Boolean);
    const out: string[] = [];
    for (const part of parts) {
      if (!hasCJK(part)) {
        out.push(asciiSlug(part));
        continue;
      }
      const surLen = COMPOUND_SURNAMES.has(part.slice(0, 2)) && part.length > 2 ? 2 : 1;
      const py = namePinyin(part);
      if (parts.length === 1 && part.length >= 2 && part.length <= 4) {
        out.push(py.slice(0, surLen).join(''), py.slice(surLen).join(''));
      } else {
        out.push(py.join(''));
      }
    }
    return out.filter(Boolean).join('-').replace(/-+/g, '-');
  }
  return asciiSlug(clean);
}

/** 搜索键：小写的姓名/别名 + 中文名的拼音全拼、带空格拼音、首字母 */
export function searchKeys(names: string[]): string[] {
  const keys = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    const n = raw.trim().toLowerCase();
    keys.add(n);
    if (hasCJK(raw)) {
      const py = namePinyin(raw.replace(/[·・\s]/g, ''));
      if (py.length) {
        keys.add(py.join(''));
        keys.add(py.join(' '));
        keys.add(py.map((p) => p[0]).join(''));
      }
    } else {
      const folded = n.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      keys.add(folded);
      keys.add(folded.replace(/[^a-z0-9]/g, ''));
    }
  }
  return [...keys].filter(Boolean);
}

/** 从模糊日期中取年份 */
export function yearOf(d?: string | null): number | undefined {
  if (!d) return undefined;
  const m = /^(-?\d{1,4})/.exec(d);
  return m ? Number(m[1]) : undefined;
}

export function normalizeSource(s: SourceInput, layer?: string): Source {
  const out: Source = typeof s === 'string' ? { url: s } : { ...s };
  if (out.url) out.url = out.url.trim();
  if (!out.publisher && out.url) out.publisher = publisherFromUrl(out.url);
  if (layer) out.layer = layer;
  return out;
}

const PUBLISHERS: Record<string, string> = {
  'wikipedia.org': 'Wikipedia',
  'wikidata.org': 'Wikidata',
  'nytimes.com': 'The New York Times',
  'wsj.com': 'The Wall Street Journal',
  'ft.com': 'Financial Times',
  'bloomberg.com': 'Bloomberg',
  'reuters.com': 'Reuters',
  'apnews.com': 'AP',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'washingtonpost.com': 'The Washington Post',
  'theguardian.com': 'The Guardian',
  'economist.com': 'The Economist',
  'scmp.com': 'South China Morning Post',
  'xinhuanet.com': '新华网',
  'news.cn': '新华网',
  'people.com.cn': '人民网',
  'gov.cn': '中国政府网',
  'ccdi.gov.cn': '中央纪委国家监委网站',
  'mod.gov.cn': '国防部',
  'whitehouse.gov': 'The White House',
  'congress.gov': 'Congress.gov',
  'sec.gov': 'SEC EDGAR',
  'fec.gov': 'FEC',
  'opensecrets.org': 'OpenSecrets',
  'forbes.com': 'Forbes',
  'icij.org': 'ICIJ',
  'rfa.org': 'RFA',
  'voachinese.com': 'VOA 中文',
  'baike.baidu.com': '百度百科',
  'github.com': 'GitHub',
  'brookings.edu': 'Brookings',
  'caixin.com': '财新',
  'cninfo.com.cn': '巨潮资讯',
  'hkexnews.hk': '港交所披露易',
  'politico.com': 'Politico',
  'axios.com': 'Axios',
  'cnn.com': 'CNN',
  'nbcnews.com': 'NBC News',
  'cnbc.com': 'CNBC',
  'senate.gov': 'U.S. Senate',
  'house.gov': 'U.S. House',
  'supremecourt.gov': 'Supreme Court',
  'federalreserve.gov': 'Federal Reserve',
  'state.gov': 'U.S. Department of State',
  'treasury.gov': 'U.S. Treasury',
  'defense.gov': 'U.S. Department of Defense',
  'war.gov': 'U.S. Department of War',
};

export function publisherFromUrl(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (const [dom, name] of Object.entries(PUBLISHERS)) {
      if (host === dom || host.endsWith('.' + dom)) return name;
    }
    return host;
  } catch {
    return undefined;
  }
}

export function uniq<T>(arr: Iterable<T>): T[] {
  return [...new Set(arr)];
}

export function uniqBy<T>(arr: Iterable<T>, key: (t: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const x of arr) {
    const k = key(x);
    if (!seen.has(k)) seen.set(k, x);
  }
  return [...seen.values()];
}

export function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function sourceKey(s: Source): string {
  return (s.url || s.title || JSON.stringify(s)).toLowerCase();
}
