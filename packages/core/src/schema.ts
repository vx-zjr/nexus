/**
 * 原始数据文件（YAML/JSON）的输入模式。宽进严出：输入允许简写，编译后统一为 types.ts 中的规范结构。
 *
 * 一个数据文件可以是以下三种之一（由字段自动识别）：
 *   1. 单实体文件   { id, type: person|org, ... }
 *   2. 档案文件     { id, kind: family|faction|..., name, core, outer, relations? }
 *   3. 批量文件     { entities?: [...], relations?: [...], dossiers?: [...], sources?, confidence? }
 */
import { z } from 'zod';
import {
  CONFIDENCE_KEYS,
  DOSSIER_KINDS,
  ORG_TYPES,
  PERSON_STATUS,
  RELATION_TYPE_KEYS,
  SECTOR_KEYS,
} from './vocab.ts';

const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

/** 模糊日期：1953 | "1953-06" | "1953-06-15"（YAML 中的数字会被转成字符串） */
export const FuzzyDate = z
  .union([z.string(), z.number().int()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d{1,4}(-\d{2}(-\d{2})?)?$/.test(v) || v === '?' || v === '', {
    message: '日期格式应为 YYYY / YYYY-MM / YYYY-MM-DD',
  });

export const SourceInput = z.union([
  z.string().min(4), // 简写：直接写 URL
  z.object({
    url: z.string().optional(),
    title: z.string().optional(),
    publisher: z.string().optional(),
    date: FuzzyDate.optional(),
    accessed: FuzzyDate.optional(),
    quote: z.string().max(400).optional(),
    note: z.string().optional(),
    archive: z.string().optional(),
  }),
]);
export type SourceInput = z.infer<typeof SourceInput>;

export const IdString = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'id 只能包含小写字母、数字、点、下划线、连字符，例如 xi-jinping')
  .max(120);

const Names = z.record(z.string(), z.string());

export const PositionInput = z.object({
  title: z.string(),
  org: IdString.optional(),
  from: FuzzyDate.optional(),
  to: FuzzyDate.optional().nullable(),
  current: z.boolean().optional(),
  note: z.string().optional(),
  confidence: enumOf(CONFIDENCE_KEYS).optional(),
  sources: z.array(SourceInput).optional(),
});

export const EducationInput = z.object({
  org: IdString,
  degree: z.string().optional(),
  field: z.string().optional(),
  from: FuzzyDate.optional(),
  to: FuzzyDate.optional().nullable(),
  sources: z.array(SourceInput).optional(),
});

const EntityBase = {
  id: IdString,
  name: z.string().min(1),
  names: Names.optional(),
  aliases: z.array(z.string()).optional(),
  country: z.union([z.string(), z.array(z.string())]).optional(),
  sectors: z.array(enumOf(SECTOR_KEYS)).optional(),
  tier: z.number().int().min(1).max(5).optional(),
  summary: z.string().optional(),
  notes: z.string().optional(),
  ids: z.record(z.string(), z.union([z.string(), z.number()]).transform(String)).optional(),
  links: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(SourceInput).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  updated: FuzzyDate.optional(),
  /** 声明与另一个 id 是同一实体（强制合并，用于消除导入层重复） */
  sameAs: z.union([IdString, z.array(IdString)]).optional(),
  /** 声明与这些 id 不是同一人（消除“疑似重复”误报） */
  distinctFrom: z.array(IdString).optional(),
};

export const PersonInput = z.object({
  ...EntityBase,
  type: z.literal('person'),
  gender: z.enum(['M', 'F', 'X']).optional(),
  born: FuzzyDate.optional().nullable(),
  died: FuzzyDate.optional().nullable(),
  birthplace: z.string().optional(),
  status: enumOf(Object.keys(PERSON_STATUS) as (keyof typeof PERSON_STATUS)[]).optional(),
  positions: z.array(PositionInput).optional(),
  education: z.array(EducationInput).optional(),
  netWorth: z
    .object({ usd: z.number(), year: FuzzyDate.optional(), source: SourceInput.optional() })
    .optional(),
});

export const OrgInput = z.object({
  ...EntityBase,
  type: z.literal('org'),
  orgType: enumOf(Object.keys(ORG_TYPES) as (keyof typeof ORG_TYPES)[]).optional(),
  founded: FuzzyDate.optional().nullable(),
  dissolved: FuzzyDate.optional().nullable(),
  parent: IdString.optional(),
  hq: z.string().optional(),
});

export const EntityInput = z.discriminatedUnion('type', [PersonInput, OrgInput]);
export type PersonInput = z.infer<typeof PersonInput>;
export type OrgInput = z.infer<typeof OrgInput>;
export type EntityInput = z.infer<typeof EntityInput>;

export const RelationObjectInput = z.object({
  from: IdString,
  to: IdString,
  type: enumOf(RELATION_TYPE_KEYS),
  label: z.string().optional(),
  since: FuzzyDate.optional().nullable(),
  until: FuzzyDate.optional().nullable(),
  current: z.boolean().optional(),
  confidence: enumOf(CONFIDENCE_KEYS).optional(),
  sources: z.array(SourceInput).optional(),
  note: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  /** 撤回：删除低优先级数据层中相同 (from,type,to) 的关系（用于纠正导入层的错误），note 写明原因 */
  retract: z.boolean().optional(),
});

/** 关系简写：[from, type, to, label?, confidence?] —— 读作一句话：“from 是 to 的 …” */
export const RelationTupleInput = z.tuple([IdString, enumOf(RELATION_TYPE_KEYS), IdString], z.string());

export const RelationInput = z.union([RelationObjectInput, RelationTupleInput]);
export type RelationObjectInput = z.infer<typeof RelationObjectInput>;

const DossierMember = z.union([
  IdString,
  z.object({ id: IdString, role: z.string().optional(), note: z.string().optional() }),
]);

export const DossierInput = z.object({
  id: IdString,
  kind: enumOf(Object.keys(DOSSIER_KINDS) as (keyof typeof DOSSIER_KINDS)[]),
  name: z.string(),
  names: Names.optional(),
  country: z.union([z.string(), z.array(z.string())]).optional(),
  /** 档案的“核心人物”（家族中最显赫者），zhao 方法论中用作家族命名 */
  head: IdString.optional(),
  /** 核心成员：通常是有直接血缘关系的成员 */
  core: z.array(DossierMember).optional(),
  /** 外围成员：姻亲、关联公司、白手套等非血缘成员 */
  outer: z.array(DossierMember).optional(),
  summary: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(SourceInput).optional(),
  confidence: enumOf(CONFIDENCE_KEYS).optional(),
  relations: z.array(RelationInput).optional(),
  updated: FuzzyDate.optional(),
});
export type DossierInput = z.infer<typeof DossierInput>;

export const BundleInput = z.object({
  /** 文件级默认来源：本文件中没有写 sources 的关系/实体都继承它 */
  sources: z.array(SourceInput).optional(),
  /** 文件级默认可信度 */
  confidence: enumOf(CONFIDENCE_KEYS).optional(),
  entities: z.array(EntityInput).optional(),
  relations: z.array(RelationInput).optional(),
  dossiers: z.array(DossierInput).optional(),
  note: z.string().optional(),
  updated: FuzzyDate.optional(),
});
export type BundleInput = z.infer<typeof BundleInput>;

export type DocKind = 'entity' | 'dossier' | 'bundle';

export function detectDocKind(doc: unknown): DocKind | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (typeof d.type === 'string' && typeof d.id === 'string') return 'entity';
  if (typeof d.kind === 'string' && typeof d.id === 'string') return 'dossier';
  if ('entities' in d || 'relations' in d || 'dossiers' in d) return 'bundle';
  return null;
}

/** 各种文件允许出现的顶层字段（用于对拼写错误给出警告） */
export const KNOWN_KEYS = {
  person: Object.keys(PersonInput.shape),
  org: Object.keys(OrgInput.shape),
  dossier: Object.keys(DossierInput.shape),
  bundle: Object.keys(BundleInput.shape),
  relation: Object.keys(RelationObjectInput.shape),
};

