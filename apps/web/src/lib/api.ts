/**
 * 本地 API 客户端（ctos serve，开发时经 Vite 代理 /api）。
 * 浏览器默认只持有“核心子图”；选中/聚焦/家族/路径涉及的其余实体与关系按需拉取，以补丁形式合并进 store。
 * API 不可用时（静态部署）自动退化为只用 graph.json 的本地模式。
 */
import type { Entity, GraphData, GraphPatch, RelFilter } from '@nexus/core';
import { useNexus } from '../store/useNexus';

export const api = { online: false, version: 0 };

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/** 探测本地 API：online = 可用；building = 已启动但首次编译未完成；offline = 不可达 */
export async function probe(): Promise<'online' | 'building' | 'offline'> {
  try {
    const h = await getJson<{ ok: boolean; version: number }>('/api/health', { signal: AbortSignal.timeout(6000) });
    api.online = h.ok;
    api.version = h.version;
    return h.ok ? 'online' : 'building';
  } catch {
    api.online = false;
    return 'offline';
  }
}

export const fetchCore = () => getJson<GraphData>('/api/core');

// ---------------- 按需补丁 ----------------
const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/** 数据整体重载（新版本）后清空补丁缓存 */
export function resetPatches() {
  loaded.clear();
  inflight.clear();
}

function ensure(key: string, path: string): Promise<void> {
  if (!api.online || loaded.has(key)) return Promise.resolve();
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = getJson<GraphPatch>(path)
    .then((patch) => {
      loaded.add(key);
      useNexus.getState().mergePatch(patch);
    })
    .catch((e: Error) => {
      loaded.add(key); // 失败（如 404）也记为已处理，避免每次状态变化都重试
      console.warn(`[nexus] ${path}: ${e.message}`);
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const enc = encodeURIComponent;
export const ensureEntity = (id: string) => ensure(`e:${id}`, `/api/entity/${enc(id)}`);
export const ensureEgo = (id: string, depth: number) => ensure(`g:${id}:${depth}`, `/api/ego/${enc(id)}?depth=${depth}`);
export const ensureFamily = (id: string, depth: number) => ensure(`f:${id}:${depth}`, `/api/family/${enc(id)}?depth=${depth}`);
export const ensureDossier = (id: string) => ensure(`d:${id}`, `/api/dossier/${enc(id)}`);

function filterQuery(f?: RelFilter) {
  const q = new URLSearchParams();
  if (f?.categories) q.set('cats', [...f.categories].join(','));
  if (f?.minConfidence) q.set('minConf', f.minConfidence);
  if (f?.excludeDerived) q.set('derived', '0');
  return q;
}

/** 全图多路径（服务端计算），返回步骤（关系以 id 表示，补丁已合并进 store） */
export async function remotePaths(a: string, b: string, k: number, f?: RelFilter): Promise<{ id: string; via?: string }[][]> {
  const q = filterQuery(f);
  q.set('a', a);
  q.set('b', b);
  q.set('k', String(k));
  const r = await getJson<{ paths: { id: string; via?: string }[][]; patch: GraphPatch }>(`/api/path?${q}`);
  useNexus.getState().mergePatch(r.patch);
  return r.paths;
}

/** 全图搜索（含未加载的 bulk 层实体） */
export async function remoteSearch(q: string, limit = 12, signal?: AbortSignal): Promise<Entity[]> {
  if (!api.online || !q.trim()) return [];
  const r = await getJson<{ entities: Entity[] }>(`/api/search?q=${enc(q)}&limit=${limit}`, { signal });
  return r.entities;
}

// ---------------- 原始数据仓库与审核队列 ----------------
export interface WarehouseHit {
  source: string;
  id: string;
  kind: string;
  name: string;
  detail?: string;
}
export const warehouseSearch = (q: string, source?: string, limit = 30) =>
  getJson<WarehouseHit[]>(`/api/warehouse/search?q=${enc(q)}&limit=${limit}${source ? `&source=${enc(source)}` : ''}`);

export interface ReviewContext {
  link: string;
  id: string;
  name: string;
  kind?: string;
  detail?: string;
  dataset?: string;
  dir: 'out' | 'in';
}
export interface ReviewCandidate {
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
  nk_score: number | null;
  country_match: number;
  ambiguity: number;
  han_exact: boolean;
  rank: number;
  decision?: { decision: 'same' | 'different' | 'unsure'; note?: string; at?: string };
  context?: ReviewContext[];
  url?: string;
}
export interface ReviewStat {
  source: string;
  label: string;
  total: number;
  pending: number;
  pendingHigh: number;
  same: number;
  different: number;
  unsure: number;
  entities: number;
}
export const reviewStats = () => getJson<ReviewStat[]>('/api/review/stats');
export const reviewList = (p: { source: string; status: string; q?: string; entity?: string; offset?: number; limit?: number }) => {
  const q = new URLSearchParams({ source: p.source, status: p.status, offset: String(p.offset ?? 0), limit: String(p.limit ?? 30) });
  if (p.q) q.set('q', p.q);
  if (p.entity) q.set('entity', p.entity);
  return getJson<{ total: number; items: ReviewCandidate[] }>(`/api/review?${q}`);
};
export const reviewDecide = (b: { source: string; entity: string; ext: string; decision: 'same' | 'different' | 'unsure'; name?: string; note?: string }) =>
  getJson<{ ok: boolean }>('/api/review/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
export const reviewApply = (source: string) =>
  getJson<{ ok: boolean; log: string[] }>('/api/review/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
