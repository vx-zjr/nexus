import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import louvain from 'graphology-communities-louvain';
import type { Entity, Relation } from '../types.ts';
import { relationDef } from '../vocab.ts';

/**
 * 为实体计算影响力评分（PageRank + tier）与社区（Louvain）。
 * 教育/成员类“弱关系”权重较低，避免“哈佛校友”这种超级节点主导评分。
 */
export function computeMetrics(entities: Entity[], relations: Relation[]): void {
  const g = new Graph({ type: 'undirected', multi: false });
  for (const e of entities) g.addNode(e.id);
  for (const r of relations) {
    const w = 1 / relationDef(r.type).weight;
    if (g.hasEdge(r.from, r.to)) {
      const k = g.edge(r.from, r.to)!;
      g.updateEdgeAttribute(k, 'weight', (x: number = 0) => x + w);
    } else g.addEdge(r.from, r.to, { weight: w });
  }

  let pr: Record<string, number> = {};
  try {
    pr = pagerank(g, { getEdgeWeight: 'weight', maxIterations: 200, tolerance: 1e-8 });
  } catch {
    pr = {};
  }
  // PageRank 转百分位，避免极值
  const sorted = Object.entries(pr).sort((a, b) => a[1] - b[1]);
  const pct = new Map<string, number>();
  sorted.forEach(([id], i) => pct.set(id, sorted.length > 1 ? i / (sorted.length - 1) : 1));

  let comm: Record<string, number> = {};
  if (g.size > 0) {
    try {
      comm = louvain(g, { getEdgeWeight: 'weight', resolution: 1 });
    } catch {
      comm = {};
    }
  }

  for (const e of entities) {
    const tierScore = e.tier ? (6 - e.tier) / 5 : 0.25;
    const p = pct.get(e.id) ?? 0;
    e.score = Math.round((0.55 * tierScore + 0.45 * p) * 1000) / 1000;
    if (comm[e.id] !== undefined) e.community = comm[e.id];
  }
}
