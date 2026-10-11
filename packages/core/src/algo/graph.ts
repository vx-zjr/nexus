/**
 * 图查询工具（无 UI 依赖）：邻居、多跳关系网、加权最短路径、家族树、搜索。
 * Web 前端、CLI、以及对接其他系统时都使用这套 API。
 */
import type { Dossier, Entity, GraphData, Relation } from '../types.ts';
import { CONFIDENCE, type Confidence, type RelationCategory, relationDef } from '../vocab.ts';

export interface RelFilter {
  categories?: RelationCategory[] | Set<RelationCategory>;
  types?: string[] | Set<string>;
  minConfidence?: Confidence;
  /** 排除派生关系（positions/education 自动生成的边） */
  excludeDerived?: boolean;
  /** 只允许经过这些实体 */
  allow?: (e: Entity) => boolean;
}

export interface PathStep {
  id: string;
  /** 从上一个节点走到本节点所经过的关系（起点为空） */
  via?: Relation;
}

export const FAMILY_TYPES = new Set(['parent', 'spouse', 'ex-spouse', 'partner', 'sibling', 'in-law', 'relative']);

export class NexusIndex {
  readonly byId = new Map<string, Entity>();
  readonly adj = new Map<string, Relation[]>();
  readonly dossierById = new Map<string, Dossier>();
  readonly relById = new Map<string, Relation>();

  constructor(readonly data: GraphData) {
    for (const e of data.entities) {
      this.byId.set(e.id, e);
      this.adj.set(e.id, []);
    }
    for (const r of data.relations) {
      this.relById.set(r.id, r);
      this.adj.get(r.from)?.push(r);
      this.adj.get(r.to)?.push(r);
    }
    for (const d of data.dossiers) this.dossierById.set(d.id, d);
  }

  get(id: string): Entity | undefined {
    return this.byId.get(id);
  }

  other(r: Relation, id: string): string {
    return r.from === id ? r.to : r.from;
  }

  passes(r: Relation, f?: RelFilter): boolean {
    if (!f) return true;
    if (f.excludeDerived && r.derived) return false;
    if (f.categories) {
      const set = f.categories instanceof Set ? f.categories : new Set(f.categories);
      if (set.size && !set.has(r.category)) return false;
    }
    if (f.types) {
      const set = f.types instanceof Set ? f.types : new Set(f.types);
      if (set.size && !set.has(r.type)) return false;
    }
    if (f.minConfidence && CONFIDENCE[r.confidence].rank < CONFIDENCE[f.minConfidence].rank) return false;
    return true;
  }

  relationsOf(id: string, f?: RelFilter): Relation[] {
    return (this.adj.get(id) ?? []).filter((r) => this.passes(r, f));
  }

  /** 多跳关系网（BFS） */
  ego(id: string, depth = 1, f?: RelFilter, maxNodes = 600): { nodes: Set<string>; relations: Relation[] } {
    const nodes = new Set<string>([id]);
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const r of this.relationsOf(n, f)) {
          const o = this.other(r, n);
          const oe = this.byId.get(o);
          if (!oe || (f?.allow && !f.allow(oe))) continue;
          if (!nodes.has(o)) {
            if (nodes.size >= maxNodes) break;
            nodes.add(o);
            next.push(o);
          }
        }
      }
      frontier = next;
    }
    return { nodes, relations: this.inducedRelations(nodes, f) };
  }

  inducedRelations(nodes: Set<string>, f?: RelFilter): Relation[] {
    // 沿邻接表收集（复杂度与子图规模成正比，而不是全图关系数）
    const out: Relation[] = [];
    const seen = new Set<string>();
    for (const n of nodes) {
      for (const r of this.adj.get(n) ?? []) {
        if (seen.has(r.id) || !nodes.has(this.other(r, n)) || !this.passes(r, f)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  /** 加权最短路径（Dijkstra），边权取自关系词表：家族最近，校友最远 */
  shortestPath(a: string, b: string, f?: RelFilter, banned?: Set<string>): PathStep[] | null {
    if (!this.byId.has(a) || !this.byId.has(b)) return null;
    const dist = new Map<string, number>([[a, 0]]);
    const prev = new Map<string, { id: string; rel: Relation }>();
    const heap = new MinHeap<string>();
    heap.push(a, 0);
    const done = new Set<string>();
    while (heap.size) {
      const [u, du] = heap.pop()!;
      if (done.has(u)) continue;
      done.add(u);
      if (u === b) break;
      for (const r of this.relationsOf(u, f)) {
        const v = this.other(r, u);
        if (banned?.has(v) && v !== b) continue;
        const ve = this.byId.get(v);
        if (!ve || (f?.allow && v !== b && !f.allow(ve))) continue;
        // 降低经由超级枢纽（如大学、政党）的路径的吸引力
        const hubPenalty = ve.type === 'org' ? Math.log10(10 + (ve.degree ?? 0)) - 1 : 0;
        const w = relationDef(r.type).weight + (6 - CONFIDENCE[r.confidence].rank) * 0.3 + hubPenalty;
        const nd = du + w;
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd);
          prev.set(v, { id: u, rel: r });
          heap.push(v, nd);
        }
      }
    }
    if (!prev.has(b) && a !== b) return null;
    const path: PathStep[] = [];
    let cur = b;
    while (cur !== a) {
      const p = prev.get(cur)!;
      path.unshift({ id: cur, via: p.rel });
      cur = p.id;
    }
    path.unshift({ id: a });
    return path;
  }

  /** 多条备选路径：依次封禁首条路径上的中间节点，求替代路径 */
  paths(a: string, b: string, k = 4, f?: RelFilter): PathStep[][] {
    const first = this.shortestPath(a, b, f);
    if (!first) return [];
    const out = [first];
    const seen = new Set([first.map((s) => s.id).join('>')]);
    const queue = first.slice(1, -1).map((s) => s.id);
    for (const mid of queue) {
      if (out.length >= k) break;
      const alt = this.shortestPath(a, b, f, new Set([mid]));
      if (!alt) continue;
      const key = alt.map((s) => s.id).join('>');
      if (!seen.has(key)) {
        seen.add(key);
        out.push(alt);
      }
    }
    return out;
  }

  /** 家族网络：只沿亲属关系扩展 */
  family(id: string, depth = 3): { nodes: Set<string>; relations: Relation[] } {
    return this.ego(id, depth, { types: FAMILY_TYPES }, 400);
  }

  /** 档案（家族/派系）子图：成员 + 成员之间的全部关系 */
  dossierGraph(dossierId: string, f?: RelFilter): { nodes: Set<string>; relations: Relation[] } {
    const d = this.dossierById.get(dossierId);
    const nodes = new Set(d?.members.map((m) => m.id) ?? []);
    return { nodes, relations: this.inducedRelations(nodes, f) };
  }

  /** 搜索：精确 > 前缀 > 包含，同分按影响力排序。支持中文、英文、拼音、拼音首字母 */
  search(query: string, limit = 20, filter?: (e: Entity) => boolean): Entity[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const qq = q.replace(/\s+/g, '');
    const scored: [Entity, number][] = [];
    for (const e of this.data.entities) {
      if (filter && !filter(e)) continue;
      let best = 0;
      if (e.id === q) best = 100;
      for (const k of e.search) {
        if (k === q || k === qq) best = Math.max(best, 90);
        else if (k.startsWith(q) || k.startsWith(qq)) best = Math.max(best, 60);
        else if (q.length >= 2 && (k.includes(q) || (qq.length >= 2 && k.includes(qq)))) best = Math.max(best, 30);
      }
      if (!best && e.id.includes(qq)) best = 20;
      if (best) scored.push([e, best + e.score * 10]);
    }
    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map((x) => x[0]);
  }
}

class MinHeap<T> {
  private items: [T, number][] = [];
  get size() {
    return this.items.length;
  }
  push(item: T, pri: number) {
    const a = this.items;
    a.push([item, pri]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][1] <= a[i][1]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [T, number] | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
