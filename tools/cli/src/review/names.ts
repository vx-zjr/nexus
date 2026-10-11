/**
 * 名字分块键（blocking keys）：把“Li Xiaolin / LI XIAO LIN / Xiaolin Li / SMITH, JOHN A / 李小琳”
 * 归一成若干个可直接比较的键，用于在百万级外部记录里快速找出候选，再交给 nomenklatura 打分。
 */
import { hasCJK, namePinyin } from '@nexus/core';

const HONORIFIC = /\b(mr|mrs|ms|miss|dr|prof|hon|sir|dame|lord|lady|jr|sr|ii|iii|iv)\b\.?/g;
const ORG_SUFFIX = /\b(limited|ltd|co|company|corp|corporation|inc|incorporated|llc|llp|lp|plc|sa|ag|gmbh|bv|nv|sarl|holdings?|group|the|of|and)\b/g;
const HAN_ONLY = /^[\u3400-\u9fff·・]+$/;

export function normalizeLatin(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 两段式键：在每个切分点把词元分成前后两段（各自连写），两段排序后用 | 连接。
 * 保留“姓 | 名”边界：LI XIAO LIN 与 Li Xiaolin 相同（li|xiaolin），但 XU Jianyuan 不会等于 Yuan Xujian。
 */
function splits(toks: string[], out: Set<string>) {
  if (toks.length < 2) return;
  for (let k = 1; k < toks.length; k++) out.add([toks.slice(0, k).join(''), toks.slice(k).join('')].sort().join('|'));
}

/** 人名中的单字母缩写（中间名首字母），用于识别 “Adam R. Lee” ≠ “Adam D. Lee” */
export function initialsOf(name: string | null | undefined): string[] {
  if (!name || HAN_ONLY.test(name.replace(/\s/g, ''))) return [];
  const toks = normalizeLatin(name).replace(HONORIFIC, ' ').split(' ').filter(Boolean);
  return toks.length >= 3 ? toks.slice(0).filter((t) => t.length === 1) : [];
}

/** 人名键：顺序无关（姓前/姓后），忽略连字符、空格、敬称；另加一组去掉单字母缩写的键 */
export function personKeys(name: string | null | undefined): string[] {
  const out = new Set<string>();
  const raw = (name ?? '').trim();
  if (!raw) return [];
  if (HAN_ONLY.test(raw.replace(/\s/g, ''))) {
    const han = raw.replace(/[\s·・]/g, '');
    if (han.length >= 2) out.add(han);
    return [...out];
  }
  const toks = normalizeLatin(raw).replace(HONORIFIC, ' ').split(' ').filter(Boolean);
  splits(toks, out);
  splits(toks.filter((t) => t.length > 1), out);
  return [...out].filter((k) => k.length >= 5);
}

/** 中文名 → 拼音键（姓 + 名；三字以上额外尝试复姓切分） */
export function pinyinKeys(zh: string): string[] {
  if (!hasCJK(zh)) return [];
  const syl = namePinyin(zh.replace(/[·・\s]/g, '')).filter(Boolean);
  if (syl.length < 2) return [];
  const out = new Set<string>();
  splits([syl[0], syl.slice(1).join('')], out);
  if (syl.length >= 3) splits([syl[0] + syl[1], syl.slice(2).join('')], out);
  return [...out];
}

/** 机构名键：去掉公司后缀与虚词后的连续串（只做完全相等匹配） */
export function orgKeys(name: string | null | undefined): string[] {
  const raw = (name ?? '').trim();
  if (!raw) return [];
  if (hasCJK(raw)) {
    const k = raw.replace(/[\s（）()·・,，.。]/g, '').replace(/(有限责任公司|股份有限公司|有限公司|集团|公司)$/u, '');
    return k.length >= 3 ? [k] : [];
  }
  const k = normalizeLatin(raw).replace(ORG_SUFFIX, ' ').replace(/\s+/g, '');
  return k.length >= 5 ? [k] : [];
}

/** ISO3 → ISO2（ICIJ 用 ISO3；只列常见的，其余按原样比较） */
const ISO3: Record<string, string> = {
  CHN: 'CN', HKG: 'HK', MAC: 'MO', TWN: 'TW', USA: 'US', SGP: 'SG', GBR: 'GB', CAN: 'CA', AUS: 'AU', JPN: 'JP', KOR: 'KR',
  VGB: 'VG', CYM: 'KY', BMU: 'BM', PAN: 'PA', WSM: 'WS', SYC: 'SC', BHS: 'BS', MUS: 'MU', CHE: 'CH', LUX: 'LU', NZL: 'NZ',
  MYS: 'MY', THA: 'TH', IDN: 'ID', PHL: 'PH', IND: 'IN', RUS: 'RU', DEU: 'DE', FRA: 'FR', ARE: 'AE', ISR: 'IL', IRL: 'IE',
  CYP: 'CY', MLT: 'MT', NLD: 'NL', JEY: 'JE', GGY: 'GG', IMN: 'IM', LIE: 'LI', MCO: 'MC', BLZ: 'BZ', ATG: 'AG', COK: 'CK',
};
export const iso2 = (c: string) => (c.length === 3 ? (ISO3[c.toUpperCase()] ?? c.toUpperCase()) : c.toUpperCase());

const GREATER_CHINA = new Set(['CN', 'HK', 'MO', 'TW']);
/** 国家兼容性：1 有交集（大中华区视为一体），0 一方未知，-1 不相交 */
export function countryMatch(a: string[], b: string[]): 1 | 0 | -1 {
  if (!a.length || !b.length) return 0;
  const A = new Set(a.map((c) => (GREATER_CHINA.has(c) ? 'GC' : c)));
  return b.some((c) => A.has(GREATER_CHINA.has(c) ? 'GC' : c)) ? 1 : -1;
}
