/**
 * 受控词表（controlled vocabulary）。
 * 新增关系类型/领域时只需在此处登记，UI、校验、导出会自动适配。
 * AI 修改数据时必须使用这里登记过的取值。
 */

export const ENTITY_TYPES = ['person', 'org'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** 人物/机构所属领域。决定 UI 配色与筛选。 */
export const SECTORS = {
  politics: { zh: '政治', en: 'Politics', color: '#ff4d5e' },
  military: { zh: '军队', en: 'Military', color: '#ff8a3d' },
  security: { zh: '安全/情报/政法', en: 'Security', color: '#e0614a' },
  judiciary: { zh: '司法', en: 'Judiciary', color: '#c792ea' },
  diplomacy: { zh: '外交', en: 'Diplomacy', color: '#7fd1b9' },
  business: { zh: '商业', en: 'Business', color: '#ffd166' },
  finance: { zh: '金融', en: 'Finance', color: '#f6c343' },
  tech: { zh: '科技', en: 'Tech', color: '#00e5ff' },
  media: { zh: '传媒', en: 'Media', color: '#9b8cff' },
  academia: { zh: '学术/智库', en: 'Academia', color: '#6fcf97' },
  culture: { zh: '文化/娱乐', en: 'Culture', color: '#f78fb3' },
  sports: { zh: '体育', en: 'Sports', color: '#56ccf2' },
  religion: { zh: '宗教', en: 'Religion', color: '#d4a373' },
  ngo: { zh: '公益/社会组织', en: 'NGO', color: '#8ecae6' },
  family: { zh: '亲属（非公众）', en: 'Family', color: '#9aa5b1' },
  other: { zh: '其他', en: 'Other', color: '#7b8794' },
} as const;
export type Sector = keyof typeof SECTORS;
export const SECTOR_KEYS = Object.keys(SECTORS) as Sector[];

export const ORG_TYPES = {
  party: '政党',
  government: '政府机构',
  legislature: '立法机构',
  court: '法院/检察',
  military: '军队/军事机构',
  soe: '国有企业',
  company: '公司',
  fund: '投资机构/基金',
  bank: '银行',
  university: '大学',
  school: '中小学/其他学校',
  'think-tank': '智库',
  media: '媒体',
  ngo: '社会组织/NGO',
  foundation: '基金会',
  religious: '宗教团体',
  committee: '委员会/领导小组',
  club: '俱乐部/协会/圈子',
  other: '其他',
} as const;
export type OrgType = keyof typeof ORG_TYPES;

/** 人物当前状态。中国政坛的“落马/调查”状态是关键情报。 */
export const PERSON_STATUS = {
  active: '在任/活跃',
  retired: '退休/离任',
  deceased: '已故',
  investigated: '被调查',
  detained: '被羁押/服刑',
  purged: '落马/被开除',
  exiled: '流亡/出走',
  unknown: '未知',
} as const;
export type PersonStatus = keyof typeof PERSON_STATUS;

/**
 * 可信度分级（每条关系、每个来源都应带上）。
 * 方法论：宁缺毋滥；传闻可以记录，但必须标注为 rumor，且 UI 会以虚线显示。
 */
export const CONFIDENCE = {
  confirmed: { zh: '确证', en: 'Confirmed', rank: 5, desc: '官方文件/一手披露，或≥2家权威媒体独立证实' },
  reported: { zh: '报道', en: 'Reported', rank: 4, desc: '单一权威媒体或维基百科等有出处的报道' },
  alleged: { zh: '指控', en: 'Alleged', rank: 3, desc: '调查报道/诉讼中的指控，尚未证实' },
  disputed: { zh: '有争议', en: 'Disputed', rank: 2, desc: '存在相互矛盾的说法' },
  rumor: { zh: '传闻', en: 'Rumor', rank: 1, desc: '网络传闻，仅作为线索，待核实' },
} as const;
export type Confidence = keyof typeof CONFIDENCE;
export const CONFIDENCE_KEYS = Object.keys(CONFIDENCE) as Confidence[];

export const RELATION_CATEGORIES = {
  family: { zh: '家族', en: 'Family', color: '#ff4d5e' },
  social: { zh: '人际', en: 'Social', color: '#00e5ff' },
  political: { zh: '政治', en: 'Political', color: '#ff8a3d' },
  professional: { zh: '职务/任职', en: 'Professional', color: '#9aa5b1' },
  financial: { zh: '资本/利益', en: 'Financial', color: '#ffd166' },
  education: { zh: '教育', en: 'Education', color: '#6fcf97' },
  legal: { zh: '司法/调查', en: 'Legal', color: '#c792ea' },
  org: { zh: '机构间', en: 'Org-Org', color: '#7b8794' },
} as const;
export type RelationCategory = keyof typeof RELATION_CATEGORIES;

export interface RelationTypeDef {
  category: RelationCategory;
  /** 有向关系：from → to 有方向含义 */
  directed: boolean;
  /** 在 from 的档案中，to 的称谓（例如 parent: to 是 from 的“子女”） */
  out: string;
  /** 在 to 的档案中，from 的称谓（例如 parent: from 是 to 的“父母”） */
  in: string;
  en: string;
  /** 路径搜索的边权（越小关系越“近”） */
  weight: number;
  /** 允许的端点类型：pp=人-人, po=人-机构, oo=机构-机构, any */
  ends: 'pp' | 'po' | 'oo' | 'any';
  desc: string;
}

/**
 * 关系类型表。
 * 约定：有向关系一律写成 “from <type> to”，读作 “from 是 to 的 <in>”。
 *   parent:  from=父/母, to=子/女
 *   patron:  from=提拔者/恩主, to=被提携者
 *   aide:    from=秘书/助手, to=上司
 *   position/member/founder/owner/board/alumni/donor/investor/advisor: from=人(或机构), to=机构/对象
 *   parent-org: from=上级/母公司, to=下属/子公司
 */
export const RELATION_TYPES = {
  // ---- 家族 ----
  parent: { category: 'family', directed: true, out: '子女', in: '父母', en: 'parent of', weight: 1, ends: 'pp', desc: 'from 是 to 的父亲或母亲（label 可写“长子/次女”等）' },
  spouse: { category: 'family', directed: false, out: '配偶', in: '配偶', en: 'spouse', weight: 1, ends: 'pp', desc: '婚姻关系（含已故配偶）' },
  'ex-spouse': { category: 'family', directed: false, out: '前配偶', in: '前配偶', en: 'former spouse', weight: 1.5, ends: 'pp', desc: '离婚' },
  partner: { category: 'family', directed: false, out: '伴侣', in: '伴侣', en: 'partner', weight: 1.5, ends: 'pp', desc: '非婚伴侣/公开恋情' },
  sibling: { category: 'family', directed: false, out: '兄弟姐妹', in: '兄弟姐妹', en: 'sibling', weight: 1, ends: 'pp', desc: '兄弟姐妹（含同父异母等，用 label 说明）' },
  'in-law': { category: 'family', directed: false, out: '姻亲', in: '姻亲', en: 'in-law', weight: 1.5, ends: 'pp', desc: '姻亲（岳父、儿媳、连襟等，用 label 说明）' },
  relative: { category: 'family', directed: false, out: '亲属', in: '亲属', en: 'relative', weight: 2, ends: 'pp', desc: '其他亲属（祖孙、叔侄、表亲等，用 label 说明）' },
  // ---- 人际 ----
  friend: { category: 'social', directed: false, out: '朋友', in: '朋友', en: 'friend', weight: 2, ends: 'pp', desc: '公开报道的私交' },
  classmate: { category: 'social', directed: false, out: '同学', in: '同学', en: 'classmate', weight: 2.5, ends: 'pp', desc: '同学/校友（有具体交集）' },
  colleague: { category: 'social', directed: false, out: '同事', in: '同事', en: 'colleague', weight: 3, ends: 'pp', desc: '共事（同一班子/同一单位）' },
  associate: { category: 'social', directed: false, out: '关联人', in: '关联人', en: 'associate', weight: 3, ends: 'any', desc: '商业或社交关联（用 label 说明）' },
  // ---- 政治 ----
  patron: { category: 'political', directed: true, out: '门生/提携对象', in: '恩主/提携者', en: 'patron of', weight: 2, ends: 'pp', desc: 'from 提拔/庇护 to（派系、旧部）' },
  aide: { category: 'political', directed: true, out: '上司', in: '秘书/助手', en: 'aide to', weight: 2, ends: 'pp', desc: 'from 曾任 to 的秘书/幕僚/办公室主任' },
  ally: { category: 'political', directed: false, out: '盟友', in: '盟友', en: 'ally', weight: 2.5, ends: 'any', desc: '政治盟友/同一派系' },
  rival: { category: 'political', directed: false, out: '对手', in: '对手', en: 'rival', weight: 4, ends: 'any', desc: '政治/商业对手' },
  appointed: { category: 'political', directed: true, out: '任命/提名', in: '任命者', en: 'appointed', weight: 3, ends: 'pp', desc: 'from 任命/提名 to' },
  // ---- 职务 ----
  position: { category: 'professional', directed: true, out: '任职机构', in: '任职者', en: 'position at', weight: 3, ends: 'po', desc: 'from 在 to 任职（label 写职务）' },
  member: { category: 'professional', directed: true, out: '所属组织', in: '成员', en: 'member of', weight: 4, ends: 'any', desc: 'from 是 to 的成员（政党、委员会、俱乐部）' },
  founder: { category: 'professional', directed: true, out: '创办', in: '创始人', en: 'founder of', weight: 2, ends: 'any', desc: 'from 创办了 to' },
  board: { category: 'professional', directed: true, out: '董事会', in: '董事', en: 'board member of', weight: 3, ends: 'po', desc: 'from 是 to 的董事/理事' },
  advisor: { category: 'professional', directed: true, out: '顾问对象', in: '顾问', en: 'advisor to', weight: 3, ends: 'any', desc: 'from 担任 to 的顾问' },
  // ---- 资本/利益 ----
  owner: { category: 'financial', directed: true, out: '持股/拥有', in: '股东/所有者', en: 'owner of', weight: 2, ends: 'any', desc: 'from 持有 to 的股份/产权（label 写比例）' },
  investor: { category: 'financial', directed: true, out: '投资', in: '投资方', en: 'investor in', weight: 3, ends: 'any', desc: 'from 投资了 to' },
  donor: { category: 'financial', directed: true, out: '捐助对象', in: '捐助者', en: 'donor to', weight: 3, ends: 'any', desc: 'from 向 to 政治献金/捐款（label 写金额与年份）' },
  'business-partner': { category: 'financial', directed: false, out: '生意伙伴', in: '生意伙伴', en: 'business partner', weight: 2, ends: 'any', desc: '合伙/合资/共同持股' },
  client: { category: 'financial', directed: true, out: '客户', in: '服务方', en: 'service provider to', weight: 3, ends: 'any', desc: 'from 为 to 提供服务（律师、游说、咨询）' },
  // ---- 教育 ----
  alumni: { category: 'education', directed: true, out: '母校', in: '校友', en: 'educated at', weight: 5, ends: 'po', desc: 'from 毕业于/就读于 to' },
  // ---- 司法 ----
  legal: { category: 'legal', directed: true, out: '涉案对象', in: '涉案方', en: 'legal action', weight: 4, ends: 'any', desc: '调查/起诉/诉讼/制裁（label 说明，from=发起方）' },
  // ---- 机构间 ----
  'parent-org': { category: 'org', directed: true, out: '下属/子公司', in: '上级/母公司', en: 'parent org of', weight: 2, ends: 'oo', desc: 'from 是 to 的上级机构/母公司' },
  'org-partner': { category: 'org', directed: false, out: '合作', in: '合作', en: 'partner org', weight: 3, ends: 'oo', desc: '合资/战略合作' },
  // ---- 兜底 ----
  related: { category: 'social', directed: false, out: '关联', in: '关联', en: 'related', weight: 4, ends: 'any', desc: '其他关联（必须写 label 说明）' },
} as const satisfies Record<string, RelationTypeDef>;

export type RelationType = keyof typeof RELATION_TYPES;
export const RELATION_TYPE_KEYS = Object.keys(RELATION_TYPES) as RelationType[];

export function relationDef(type: string): RelationTypeDef {
  return (RELATION_TYPES as Record<string, RelationTypeDef>)[type] ?? RELATION_TYPES.related;
}

/** 档案（dossier）种类：zhao 项目的“家族”在这里推广为多种圈子 */
export const DOSSIER_KINDS = {
  family: '家族',
  faction: '派系',
  network: '关系网/圈子',
  institution: '机构班子',
  case: '案件/事件',
  watchlist: '观察名单',
} as const;
export type DossierKind = keyof typeof DOSSIER_KINDS;

/** 常用国家/地区代码（ISO 3166-1 alpha-2）。可扩展。 */
export const COUNTRIES: Record<string, { zh: string; en: string; color: string }> = {
  CN: { zh: '中国', en: 'China', color: '#ff4d5e' },
  HK: { zh: '中国香港', en: 'Hong Kong', color: '#ff7a85' },
  MO: { zh: '中国澳门', en: 'Macau', color: '#ff9aa2' },
  TW: { zh: '台湾', en: 'Taiwan', color: '#a3e635' },
  US: { zh: '美国', en: 'United States', color: '#3b9cff' },
  GB: { zh: '英国', en: 'United Kingdom', color: '#a78bfa' },
  CA: { zh: '加拿大', en: 'Canada', color: '#f472b6' },
  AU: { zh: '澳大利亚', en: 'Australia', color: '#fbbf24' },
  SG: { zh: '新加坡', en: 'Singapore', color: '#34d399' },
  JP: { zh: '日本', en: 'Japan', color: '#f87171' },
  RU: { zh: '俄罗斯', en: 'Russia', color: '#94a3b8' },
  IL: { zh: '以色列', en: 'Israel', color: '#60a5fa' },
  ZA: { zh: '南非', en: 'South Africa', color: '#fde047' },
  FR: { zh: '法国', en: 'France', color: '#818cf8' },
  CH: { zh: '瑞士', en: 'Switzerland', color: '#fca5a5' },
  DE: { zh: '德国', en: 'Germany', color: '#fcd34d' },
  NZ: { zh: '新西兰', en: 'New Zealand', color: '#86efac' },
  LB: { zh: '黎巴嫩', en: 'Lebanon', color: '#fca5a5' },
  AE: { zh: '阿联酋', en: 'UAE', color: '#fdba74' },
  SA: { zh: '沙特', en: 'Saudi Arabia', color: '#bef264' },
  VG: { zh: '英属维尔京群岛', en: 'British Virgin Islands', color: '#94a3b8' },
  KY: { zh: '开曼群岛', en: 'Cayman Islands', color: '#94a3b8' },
  GD: { zh: '格林纳达', en: 'Grenada', color: '#94a3b8' },
  IN: { zh: '印度', en: 'India', color: '#fb923c' },
  KR: { zh: '韩国', en: 'South Korea', color: '#93c5fd' },
  IE: { zh: '爱尔兰', en: 'Ireland', color: '#4ade80' },
  IT: { zh: '意大利', en: 'Italy', color: '#a3e635' },
  HU: { zh: '匈牙利', en: 'Hungary', color: '#fda4af' },
};
export function countryColor(code?: string): string {
  return (code && COUNTRIES[code]?.color) || '#b8c2cc';
}

/**
 * 隐私红线：任何层级的数据中都不允许出现这些字段（防止人肉/开盒）。
 * 本项目只收集公开的身份、职务、关系与资本信息。
 */
export const FORBIDDEN_FIELDS = [
  'address', 'home_address', 'homeAddress', 'residence', 'phone', 'mobile', 'telephone',
  'email', 'id_number', 'idNumber', 'id_card', 'passport', 'ssn', 'license_plate',
  'plate', 'bank_account', 'medical', 'health_record', 'gps', 'coordinates',
] as const;

/** 未成年人保护：出生年份距今不足该值且在世的人物，不得收录 */
export const MINOR_AGE = 18;
