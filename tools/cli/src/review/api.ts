/**
 * 审核队列的 HTTP 接口（挂在 ctos serve 下）：
 *   GET  /api/review/sources                     可用来源
 *   GET  /api/review/stats                       各来源候选/已裁决统计
 *   GET  /api/review?source=&status=&q=&entity=&limit=&offset=   候选列表（附上下文与原始链接）
 *   POST /api/review/decide  {source, entity, ext, decision, name?, note?}   写入裁决（data/curated/_matches/）
 *   POST /api/review/apply   {source}                    运行对应投影连接器（把已确认的匹配写入图谱层）
 */
import type http from 'node:http';
import { DATA_DIR } from '../lib.ts';
import { openWarehouse } from '../warehouse/db.ts';
import { queryCandidates, reviewStats, type ReviewStatus } from './query.ts';
import { REVIEW_SOURCES } from './sources.ts';
import { DECISIONS, saveDecision, type Decision } from './store.ts';

type Json = (res: http.ServerResponse, code: number, body: unknown) => void;

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1e6) throw new Error('请求体过大');
  }
  return s ? JSON.parse(s) : {};
}

export async function handleReview(req: http.IncomingMessage, res: http.ServerResponse, u: URL, json: Json) {
  const p = u.pathname.replace(/\/+$/, '');
  if (p === '/api/review/decide') {
    if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' });
    const b = (await readBody(req)) as { source?: string; entity?: string; ext?: string; decision?: Decision; name?: string; note?: string };
    if (!b.source || !REVIEW_SOURCES[b.source] || !b.entity || !b.ext || !b.decision || !DECISIONS.includes(b.decision)) {
      return json(res, 400, { error: `需要 source、entity、ext、decision（${DECISIONS.join('|')}）` });
    }
    saveDecision(b.source, { entity: b.entity, ext: String(b.ext), decision: b.decision, name: b.name, note: b.note, by: 'web' });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/review/apply') {
    if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' });
    const b = (await readBody(req)) as { source?: string };
    const { CONNECTORS } = await import('../connectors/index.ts');
    const conn = b.source && REVIEW_SOURCES[b.source] ? CONNECTORS[b.source] : undefined;
    if (!conn) return json(res, 400, { error: `没有对应的投影连接器：${b.source}` });
    const lines: string[] = [];
    await conn.run({ args: [], dataDir: DATA_DIR, log: (m) => lines.push(m) });
    return json(res, 200, { ok: true, log: lines });
  }
  if (p === '/api/review/sources') return json(res, 200, Object.values(REVIEW_SOURCES).map((s) => ({ id: s.id, label: s.label })));
  const wh = await openWarehouse({ readOnly: true, threads: 4, memory: '4GB' });
  try {
    if (p === '/api/review/stats') return json(res, 200, await reviewStats(wh.conn));
    if (p === '/api/review') {
      const q = u.searchParams;
      const out = await queryCandidates(wh.conn, {
        source: q.get('source') ?? 'icij',
        status: (q.get('status') as ReviewStatus | null) ?? 'pending',
        q: q.get('q') ?? undefined,
        entity: q.get('entity') ?? undefined,
        minRank: q.get('minRank') ? Number(q.get('minRank')) : undefined,
        limit: Math.min(Number(q.get('limit') ?? 50), 200),
        offset: Number(q.get('offset') ?? 0),
      });
      return json(res, 200, out);
    }
    return json(res, 404, { error: `未知接口 ${p}` });
  } finally {
    wh.close();
  }
}
