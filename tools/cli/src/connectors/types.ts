import { compile, slugify, yearOf, hasCJK, type Entity } from '@nexus/core';
import { loadDocs, loadLayers } from '../lib.ts';

export interface ConnectorContext {
  args: string[];
  dataDir: string;
  log: (msg: string) => void;
}

/**
 * 数据连接器接口。新增一个数据源 = 在 connectors/ 下实现一个 Connector 并在 index.ts 登记。
 * 连接器只往 data/imports/<layer>/ 写文件，绝不修改 curated 层。
 */
export interface Connector {
  id: string;
  description: string;
  run(ctx: ConnectorContext): Promise<void>;
}

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[\s·・.\-_'’]/g, '');

/**
 * 跨数据层的 ID 分配器：导入时优先复用已存在实体的 id，保证不同来源的同一个人自动合并，
 * 同时避免把同名不同人错误合并（用出生年份校验）。
 */
export class IdAllocator {
  private byExt = new Map<string, string>();
  private byName = new Map<string, Entity[]>();
  private taken = new Map<string, Entity | null>();

  /** 上一次导入时 “外部ID → id” 的映射：保证重复导入时 id 稳定（精编层引用不会失效） */
  private prior = new Map<string, string>();

  constructor(excludeLayer: string, dataDir: string) {
    const all = loadLayers(dataDir);
    const layers = all.filter((l) => l.id !== excludeLayer);
    const { docs } = loadDocs(dataDir, layers);
    const data = compile(docs, { layers, metrics: false });
    for (const e of data.entities) this.register(e);
    const own = all.find((l) => l.id === excludeLayer);
    if (own) {
      const { docs: prevDocs } = loadDocs(dataDir, [own]);
      const prev = compile(prevDocs, { layers: [own], metrics: false });
      for (const e of prev.entities) for (const [k, v] of Object.entries(e.ids)) this.prior.set(`${k}:${v.toLowerCase()}`, e.id);
    }
  }

  register(e: Pick<Entity, 'id' | 'type' | 'name' | 'names' | 'aliases' | 'ids' | 'born'>) {
    this.taken.set(e.id, e as Entity);
    for (const [k, v] of Object.entries(e.ids ?? {})) this.byExt.set(`${k}:${String(v).toLowerCase()}`, e.id);
    for (const n of new Set([e.name, ...Object.values(e.names ?? {}), ...(e.aliases ?? [])])) {
      const key = `${e.type}|${norm(n)}`;
      if (!key.endsWith('|')) (this.byName.get(key) ?? this.byName.set(key, []).get(key)!).push(e as Entity);
    }
  }

  /**
   * @param want 候选实体信息
   * @param strictName 仅按名字匹配时，是否要求出生年份一致（人物默认要求）
   */
  /** id 是否属于其他数据层已有的实体（用于判断“补充已有人物”还是“新建人物”） */
  known(id: string): boolean {
    return !!this.taken.get(id);
  }

  /** 其他数据层中带某类外部 ID 的全部对照：[外部ID（小写）, 实体 id] */
  withExt(key: string): [string, string][] {
    const out: [string, string][] = [];
    for (const [k, id] of this.byExt) if (k.startsWith(`${key}:`) && this.taken.get(id)) out.push([k.slice(key.length + 1), id]);
    return out;
  }

  /** 其他数据层中已有的实体（id → 实体） */
  existing(id: string): Pick<Entity, 'id' | 'type' | 'name'> | undefined {
    return this.taken.get(id) ?? undefined;
  }

  /**
   * @param opts.strict 仅按名字匹配时必须出生年份一致（大批量导入时用，避免同名不同人被误并）
   */
  resolve(want: { type: 'person' | 'org'; name: string; names?: Record<string, string>; ids?: Record<string, string>; born?: string | null }, opts: { strict?: boolean } = {}): string {
    for (const [k, v] of Object.entries(want.ids ?? {})) {
      const hit = this.byExt.get(`${k}:${v.toLowerCase()}`);
      if (hit) return hit;
    }
    // 沿用上一次导入分配的 id（若未被其他层占用）
    for (const [k, v] of Object.entries(want.ids ?? {})) {
      const prev = this.prior.get(`${k}:${v.toLowerCase()}`);
      if (prev && !this.taken.has(prev)) {
        this.taken.set(prev, null);
        this.byExt.set(`${k}:${v.toLowerCase()}`, prev);
        return prev;
      }
    }
    const by = yearOf(want.born ?? undefined);
    for (const n of new Set([want.name, ...Object.values(want.names ?? {})])) {
      const cands = this.byName.get(`${want.type}|${norm(n)}`) ?? [];
      for (const c of cands) {
        const cy = yearOf(c.born ?? undefined);
        if (want.type === 'org') return c.id;
        // 中文全名重名概率较低，但仍需出生年份不冲突
        if (by && cy && Math.abs(by - cy) <= 1) return c.id;
        // 三字及以上中文全名：一方缺少出生年份时也视为同一人（精编层常不写生年）
        if (!opts.strict && (!by || !cy) && hasCJK(n) && n.length >= 3) return c.id;
      }
    }
    const base = slugify(want.names?.en && !hasCJK(want.names.en) ? want.names.en : want.name, want.type) || 'x';
    let id = base;
    if (this.taken.has(id)) id = by ? `${base}-${by}` : `${base}-2`;
    let n = 2;
    while (this.taken.has(id)) id = `${base}-${by ?? ''}${by ? '-' : ''}${++n}`.replace(/--+/g, '-');
    this.taken.set(id, null);
    for (const [k, v] of Object.entries(want.ids ?? {})) this.byExt.set(`${k}:${v.toLowerCase()}`, id);
    return id;
  }
}
