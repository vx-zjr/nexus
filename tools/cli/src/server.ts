/**
 * NEXUS 本地 API 服务（ctos serve）：在内存中持有完整图谱，供前端按需查询；监听 data/ 变动自动重编译。
 *
 *   GET /api/health                       版本、规模、编译状态
 *   GET /api/core                         核心子图（与 public/data/graph.json 相同，浏览器启动时加载）
 *   GET /api/search?q=&limit=             全图搜索（含 bulk 层）
 *   GET /api/entity/:id                   补丁：实体 + 全部直接关系 + 邻居
 *   GET /api/ego/:id?depth=&max=          补丁：多跳关系网（支持 cats/minConf/derived 关系筛选参数）
 *   GET /api/family/:id?depth=            补丁：家族网络
 *   GET /api/dossier/:id                  补丁：档案成员子图
 *   GET /api/path?a=&b=&k=                多条最短路径 + 补丁
 *   GET /api/warehouse/status             原始数据仓库各表规模
 *   GET /api/warehouse/search?q=&source=  在原始仓库中检索（OpenSanctions/ICIJ/FEC/国会/法官/LittleSis）
 *   GET /api/review?status=&source=       身份匹配待审队列；POST /api/review/:id {decision} 裁决
 *   GET /api/events                       SSE：数据重编译后推送 {type:'data', version}
 *
 * 只监听 127.0.0.1。仓库按请求以只读方式打开、用完即关，不阻塞命令行的入库操作。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import {
  NexusIndex,
  makePatch,
  type Confidence,
  type GraphData,
  type GraphPatch,
  type RelFilter,
  type RelationCategory,
} from '@nexus/core';
import { DATA_DIR, buildGraphData, coreJson, writeWebData } from './lib.ts';

export const DEFAULT_PORT = Number(process.env.NEXUS_API_PORT ?? 5318);

interface State {
  data: GraphData;
  index: NexusIndex;
  core: string;
  version: number;
  builtAt: string;
  buildMs: number;
}

function slimEntity<T extends { sources: { layer?: string; accessed?: string }[] }>(e: T): T {
  return { ...e, sources: e.sources.map(({ layer: _l, accessed: _a, ...s }) => s) };
}
function slimPatch(p: GraphPatch): GraphPatch {
  return {
    entities: p.entities.map(slimEntity),
    relations: p.relations.map(({ file: _f, ...r }) => ({ ...r, sources: r.sources.map(({ layer: _l, accessed: _a, ...s }) => s) })) as GraphPatch['relations'],
  };
}

function relFilter(u: URL): RelFilter {
  const cats = u.searchParams.get('cats');
  return {
    categories: cats ? (cats.split(',').filter(Boolean) as RelationCategory[]) : undefined,
    minConfidence: (u.searchParams.get('minConf') as Confidence | null) ?? undefined,
    excludeDerived: u.searchParams.get('derived') === '0',
  };
}

export async function serve(opts: { port?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  const port = opts.port ?? DEFAULT_PORT;
  let state: State | undefined;
  let building = false;
  let pending = false;
  let lastError: string | undefined;
  const clients = new Set<http.ServerResponse>();

  const rebuild = () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    const t = Date.now();
    // 让出事件循环，避免阻塞正在进行的请求的响应写出
    setImmediate(() => {
      try {
        const data = buildGraphData({ layout: true });
        const core = coreJson(data);
        writeWebData(data, undefined, core);
        state = { data, index: new NexusIndex(data), core, version: (state?.version ?? 0) + 1, builtAt: new Date().toISOString(), buildMs: Date.now() - t };
        lastError = undefined;
        const c = data.meta.counts;
        log(`[nexus-api] 编译完成 v${state.version}（${(state.buildMs / 1000).toFixed(1)}s）实体 ${c.entities} 关系 ${c.relations}，核心子图 ${(core.length / 1e6).toFixed(1)}MB，错误 ${data.meta.issues.errors}`);
        for (const res of clients) res.write(`data: ${JSON.stringify({ type: 'data', version: state.version })}\n\n`);
      } catch (e) {
        lastError = (e as Error).stack ?? String(e);
        log(`[nexus-api] 编译失败：${(e as Error).message}`);
      } finally {
        building = false;
        if (pending) {
          pending = false;
          rebuild();
        }
      }
    });
  };

  // ---- 监听 data/（仓库目录除外）
  let timer: NodeJS.Timeout | undefined;
  fs.watch(DATA_DIR, { recursive: true }, (_ev, file) => {
    if (!file || file.startsWith('warehouse') || !/\.(ya?ml|json)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 500);
  });

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(s);
  };

  const withWarehouse = async <T>(fn: (conn: import('@duckdb/node-api').DuckDBConnection) => Promise<T>): Promise<T> => {
    const { openWarehouse } = await import('./warehouse/db.ts');
    const wh = await openWarehouse({ readOnly: true, threads: 4, memory: '4GB' });
    try {
      return await fn(wh.conn);
    } finally {
      wh.close();
    }
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = u.pathname.replace(/\/+$/, '');
    try {
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', version: state?.version ?? 0 })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/health') {
        return json(res, 200, { ok: !!state, building, version: state?.version ?? 0, builtAt: state?.builtAt, buildMs: state?.buildMs, counts: state?.data.meta.counts, error: lastError });
      }
      if (p.startsWith('/api/warehouse/')) {
        const sub = p.slice('/api/warehouse/'.length);
        if (sub === 'status') {
          return json(res, 200, await withWarehouse(async (conn) => {
            const { all, tableExists } = await import('./warehouse/db.ts');
            return (await tableExists(conn, 'wh_sources')) ? await all(conn, 'SELECT * FROM wh_sources ORDER BY source') : [];
          }));
        }
        if (sub === 'search') {
          const q = u.searchParams.get('q') ?? '';
          if (!q.trim()) return json(res, 400, { error: '缺少 q' });
          const { searchWarehouse } = await import('./warehouse/search.ts');
          return json(res, 200, await withWarehouse((conn) => searchWarehouse(conn, q, { source: u.searchParams.get('source') ?? undefined, limit: Number(u.searchParams.get('limit') ?? 30) })));
        }
      }
      if (p === '/api/review' || p.startsWith('/api/review/')) {
        const { handleReview } = await import('./review/api.ts');
        return await handleReview(req, res, u, json);
      }
      if (!state) return json(res, 503, { error: building ? '正在编译，请稍候' : (lastError ?? '尚未编译') });
      const { index, data } = state;
      if (p === '/api/core') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-nexus-version': String(state.version) });
        return res.end(state.core);
      }
      if (p === '/api/search') {
        const q = u.searchParams.get('q') ?? '';
        const type = u.searchParams.get('type');
        const hits = index.search(q, Math.min(Number(u.searchParams.get('limit') ?? 30), 200), type ? (e) => e.type === type : undefined);
        return json(res, 200, { entities: hits.map(slimEntity) });
      }
      const m = /^\/api\/(entity|ego|family|dossier)\/(.+)$/.exec(p);
      if (m) {
        const [, kind, raw] = m;
        const id = decodeURIComponent(raw);
        const get = (x: string) => index.get(x);
        if (kind === 'dossier') {
          const d = index.dossierById.get(id);
          if (!d) return json(res, 404, { error: `无此档案 ${id}` });
          const g = index.dossierGraph(id);
          return json(res, 200, slimPatch(makePatch(get, g.nodes, g.relations)));
        }
        if (!index.get(id)) return json(res, 404, { error: `无此实体 ${id}` });
        if (kind === 'entity') return json(res, 200, slimPatch(makePatch(get, [id], index.relationsOf(id))));
        if (kind === 'family') {
          // 家族成员 + 成员之间的全部关系（家族视图可选显示姻亲公司、秘书等非亲属关系）
          const g = index.family(id, Math.min(Number(u.searchParams.get('depth') ?? 3), 6));
          return json(res, 200, slimPatch(makePatch(get, g.nodes, index.inducedRelations(g.nodes))));
        }
        const g = index.ego(id, Math.min(Number(u.searchParams.get('depth') ?? 1), 3), relFilter(u), Math.min(Number(u.searchParams.get('max') ?? 900), 3000));
        return json(res, 200, slimPatch(makePatch(get, g.nodes, g.relations)));
      }
      if (p === '/api/path') {
        const a = u.searchParams.get('a') ?? '', b = u.searchParams.get('b') ?? '';
        if (!index.get(a) || !index.get(b)) return json(res, 404, { error: '起点或终点不存在' });
        const paths = index.paths(a, b, Math.min(Number(u.searchParams.get('k') ?? 4), 8), relFilter(u));
        const rels = paths.flatMap((pth) => pth.map((s) => s.via).filter(Boolean)) as GraphData['relations'];
        return json(res, 200, { paths: paths.map((pth) => pth.map((s) => ({ id: s.id, via: s.via?.id }))), patch: slimPatch(makePatch((x) => index.get(x), [a, b], rels)) });
      }
      if (p === '/api/stats') return json(res, 200, { meta: data.meta });
      return json(res, 404, { error: `未知接口 ${p}` });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  log(`[nexus-api] http://127.0.0.1:${port}/api  （数据目录 ${path.relative(process.cwd(), DATA_DIR) || DATA_DIR}）`);
  rebuild();
  return server;
}
