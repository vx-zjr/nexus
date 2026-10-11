/**
 * 审核队列查询（CLI 与本地 API 共用）：候选来自仓库表 review_candidates，裁决来自 data/curated/_matches/*.yaml。
 * 排序：同一图谱实体的候选排在一起，实体按其最佳候选的 rank 降序。
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import { all, lit, tableExists } from '../warehouse/db.ts';
import { REVIEW_SOURCES, type ContextItem } from './sources.ts';
import { decisionKey, decisionMap, type MatchDecision } from './store.ts';

export interface Candidate {
  cand_id: string;
  source: string;
  entity_id: string;
  entity_name: string;
  entity_type: string;
  entity_tier: number;
  ext_id: string;
  ext_name: string;
  ext_kind: string;
  ext_countries: string[];
  ext_dataset: string | null;
  ext_detail: string | null;
  match_key: string;
  nk_score: number | null;
  country_match: number;
  ambiguity: number;
  han_exact: boolean;
  rank: number;
  decision?: MatchDecision;
  context?: ContextItem[];
  url?: string;
}

export type ReviewStatus = 'pending' | 'same' | 'different' | 'unsure' | 'decided' | 'all';

export interface ReviewQuery {
  source: string;
  status?: ReviewStatus;
  q?: string;
  entity?: string;
  minRank?: number;
  limit?: number;
  offset?: number;
  withContext?: boolean;
}

export async function queryCandidates(conn: DuckDBConnection, o: ReviewQuery): Promise<{ total: number; items: Candidate[] }> {
  const src = REVIEW_SOURCES[o.source];
  if (!src) throw new Error(`未知审核来源 ${o.source}`);
  if (!(await tableExists(conn, 'review_candidates'))) return { total: 0, items: [] };
  const where = [`source = ${lit(o.source)}`];
  if (o.q) where.push(`(lower(entity_name) LIKE ${lit(`%${o.q.toLowerCase()}%`)} OR lower(ext_name) LIKE ${lit(`%${o.q.toLowerCase()}%`)} OR entity_id = ${lit(o.q)})`);
  if (o.entity) where.push(`entity_id = ${lit(o.entity)}`);
  if (o.minRank !== undefined) where.push(`rank >= ${Number(o.minRank)}`);
  const rows = await all<Candidate>(
    conn,
    `SELECT * EXCLUDE (created_at), max(rank) OVER (PARTITION BY entity_id) AS best FROM review_candidates WHERE ${where.join(' AND ')}
     ORDER BY round(best, 1) DESC, entity_tier, best DESC, entity_id, rank DESC`,
  );
  const dec = decisionMap(o.source);
  const status = o.status ?? 'pending';
  const filtered = rows.filter((r) => {
    r.decision = dec.get(decisionKey(r.entity_id, r.ext_id));
    if (status === 'all') return true;
    if (status === 'pending') return !r.decision;
    if (status === 'decided') return !!r.decision;
    return r.decision?.decision === status;
  });
  const page = filtered.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 50));
  if (o.withContext !== false && page.length) {
    const ctx = await src.context(conn, [...new Set(page.map((r) => r.ext_id))]);
    for (const r of page) r.context = ctx[r.ext_id] ?? [];
  }
  for (const r of page) {
    r.url = src.url(r.ext_id);
    delete (r as Partial<Candidate> & { best?: number }).best;
  }
  return { total: filtered.length, items: page };
}

export async function reviewStats(conn: DuckDBConnection) {
  if (!(await tableExists(conn, 'review_candidates'))) return [];
  const rows = await all<{ source: string; entity_id: string; ext_id: string; rank: number }>(conn, `SELECT source, entity_id, ext_id, rank FROM review_candidates`);
  const out = new Map<string, { source: string; label: string; total: number; pending: number; pendingHigh: number; same: number; different: number; unsure: number; entities: number }>();
  const maps = new Map<string, Map<string, MatchDecision>>();
  const ents = new Map<string, Set<string>>();
  for (const r of rows) {
    const m = maps.get(r.source) ?? maps.set(r.source, decisionMap(r.source)).get(r.source)!;
    const s = out.get(r.source) ?? out.set(r.source, { source: r.source, label: REVIEW_SOURCES[r.source]?.label ?? r.source, total: 0, pending: 0, pendingHigh: 0, same: 0, different: 0, unsure: 0, entities: 0 }).get(r.source)!;
    (ents.get(r.source) ?? ents.set(r.source, new Set()).get(r.source)!).add(r.entity_id);
    s.total++;
    const d = m.get(decisionKey(r.entity_id, r.ext_id));
    if (!d) {
      s.pending++;
      if (r.rank >= 0.5) s.pendingHigh++;
    } else s[d.decision]++;
  }
  for (const [k, s] of out) s.entities = ents.get(k)?.size ?? 0;
  return [...out.values()];
}
