import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { GraphData } from '../types.ts';
import { relationDef } from '../vocab.ts';

export type LayoutCache = Record<string, [number, number]>;

/** 基于字符串的确定性伪随机数，保证同一 id 初始位置稳定 */
function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * 全局布局（ForceAtlas2）。为了让“地图记忆”稳定，复用缓存坐标，只对新节点做增量布局。
 * @param full 为 true 时忽略缓存全量重排
 */
export function layoutGraph(data: GraphData, cache: LayoutCache = {}, opts: { full?: boolean; iterations?: number } = {}): LayoutCache {
  const g = new Graph({ type: 'undirected', multi: false });
  // 国家分区作为初始位置：中国在左、美国在右，其他在下方，便于肉眼识别跨国关系
  const anchor = (c?: string): [number, number] =>
    c === 'CN' || c === 'HK' || c === 'MO' ? [-600, 0] : c === 'US' ? [600, 0] : [0, 500];
  let fresh = 0;
  for (const e of data.entities) {
    const cached = !opts.full ? cache[e.id] : undefined;
    let x: number, y: number;
    if (cached) [x, y] = cached;
    else {
      fresh++;
      const [ax, ay] = anchor(e.country[0]);
      x = ax + (hash01(e.id) - 0.5) * 800;
      y = ay + (hash01(e.id, 7) - 0.5) * 800;
    }
    g.addNode(e.id, { x, y, size: 1 + Math.sqrt(e.degree), fixed: false });
  }
  for (const r of data.relations) {
    if (g.hasEdge(r.from, r.to)) continue;
    g.addEdge(r.from, r.to, { weight: 2 / relationDef(r.type).weight });
  }
  // 新节点放到已有邻居的质心附近
  if (!opts.full) {
    for (const e of data.entities) {
      if (cache[e.id]) continue;
      const ns = g.neighbors(e.id).filter((n) => cache[n]);
      if (!ns.length) continue;
      const cx = ns.reduce((s, n) => s + cache[n][0], 0) / ns.length;
      const cy = ns.reduce((s, n) => s + cache[n][1], 0) / ns.length;
      g.mergeNodeAttributes(e.id, { x: cx + (hash01(e.id) - 0.5) * 40, y: cy + (hash01(e.id, 3) - 0.5) * 40 });
    }
  }
  const n = g.order;
  const needFull = opts.full || fresh > n * 0.3;
  const iterations = opts.iterations ?? (needFull ? (n > 5000 ? 250 : n > 1500 ? 400 : 600) : fresh ? 60 : 0);
  if (iterations > 0 && n > 1) {
    const settings = forceAtlas2.inferSettings(g);
    forceAtlas2.assign(g, {
      iterations,
      getEdgeWeight: 'weight',
      settings: { ...settings, barnesHutOptimize: n > 800, gravity: 0.5, scalingRatio: 8, adjustSizes: false, linLogMode: false, outboundAttractionDistribution: true },
    });
  }
  const out: LayoutCache = {};
  g.forEachNode((id, a) => {
    out[id] = [Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10];
  });
  for (const e of data.entities) {
    e.x = out[e.id][0];
    e.y = out[e.id][1];
  }
  return out;
}
