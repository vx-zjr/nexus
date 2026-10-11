/**
 * 编译后的规范数据结构（graph.json 的格式）。
 * 前端、导出器、外部系统都只依赖这里的类型 —— 这是 NEXUS 对外的稳定契约。
 */
import type {
  Confidence,
  DossierKind,
  EntityType,
  OrgType,
  PersonStatus,
  RelationCategory,
  RelationType,
  Sector,
} from './vocab.ts';

export const GRAPH_SCHEMA_VERSION = 1;

export interface Source {
  url?: string;
  title?: string;
  publisher?: string;
  date?: string;
  accessed?: string;
  quote?: string;
  note?: string;
  archive?: string;
  /** 来源所在的数据层（curated / wikidata / zhao ...） */
  layer?: string;
}

export interface Position {
  title: string;
  org?: string;
  from?: string;
  to?: string | null;
  current?: boolean;
  note?: string;
  confidence?: Confidence;
  sources?: Source[];
}

export interface Education {
  org: string;
  degree?: string;
  field?: string;
  from?: string;
  to?: string | null;
}

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  names: Record<string, string>;
  aliases: string[];
  country: string[];
  sectors: Sector[];
  tier?: number;
  summary?: string;
  notes?: string;
  ids: Record<string, string>;
  links: string[];
  tags: string[];
  sources: Source[];
  attrs?: Record<string, unknown>;
  updated?: string;

  // person
  gender?: 'M' | 'F' | 'X';
  born?: string | null;
  died?: string | null;
  birthplace?: string;
  status?: PersonStatus;
  positions?: Position[];
  education?: Education[];
  netWorth?: { usd: number; year?: string };

  // org
  orgType?: OrgType;
  founded?: string | null;
  dissolved?: string | null;
  parent?: string;
  hq?: string;

  // ---- 编译期派生字段 ----
  /** 该实体出现在哪些数据层 */
  layers: string[];
  /** 定义该实体的文件（相对 data/ 的路径），方便 AI/人直接打开修改 */
  files: string[];
  /** 所属档案（家族/派系…） */
  dossiers: string[];
  degree: number;
  /** 影响力评分（PageRank 与 tier 的混合，0..1） */
  score: number;
  community?: number;
  x?: number;
  y?: number;
  /** 搜索键：各语言姓名、别名、拼音全拼与首字母（小写） */
  search: string[];
}

export interface Relation {
  id: string;
  from: string;
  to: string;
  type: RelationType;
  category: RelationCategory;
  directed: boolean;
  label?: string;
  since?: string | null;
  until?: string | null;
  current?: boolean;
  confidence: Confidence;
  sources: Source[];
  note?: string;
  attrs?: Record<string, unknown>;
  layer: string;
  file?: string;
  /** 由 positions/education/parent 等字段派生而来（而非显式书写） */
  derived?: boolean;
}

export interface DossierMember {
  id: string;
  role: 'core' | 'outer';
  note?: string;
}

export interface Dossier {
  id: string;
  kind: DossierKind;
  name: string;
  names: Record<string, string>;
  country: string[];
  head?: string;
  members: DossierMember[];
  summary?: string;
  notes?: string;
  tags: string[];
  sources: Source[];
  layer: string;
  file?: string;
  updated?: string;
}

export interface Issue {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  file?: string;
  id?: string;
}

export interface LayerInfo {
  id: string;
  name: string;
  priority: number;
  license?: string;
  description?: string;
  defaultConfidence?: Confidence;
  bulk?: boolean;
  entityCount: number;
  relationCount: number;
}

export interface GraphMeta {
  schemaVersion: number;
  generatedAt: string;
  layers: LayerInfo[];
  counts: {
    entities: number;
    persons: number;
    orgs: number;
    relations: number;
    dossiers: number;
    sources: number;
    byCountry: Record<string, number>;
    bySector: Record<string, number>;
    byCategory: Record<string, number>;
    byConfidence: Record<string, number>;
  };
  issues: { errors: number; warnings: number };
  /** 当前数据是否为核心子图（浏览器默认加载）；full 为完整图谱的规模 */
  subset?: { kind: 'core'; maxTier: number; full: { entities: number; relations: number } };
}

export interface GraphData {
  meta: GraphMeta;
  entities: Entity[];
  relations: Relation[];
  dossiers: Dossier[];
  issues: Issue[];
}
