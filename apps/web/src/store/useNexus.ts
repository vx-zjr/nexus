/**
 * 全局状态（zustand）。所有视图共享：数据、选中对象、视图、范围（scope）、筛选器。
 * 状态与 URL hash 双向同步，方便分享链接/书签（例如 #view=family&sel=xi-jinping）。
 */
import { create } from 'zustand';
import {
  NexusIndex,
  mergePatch as mergeGraphPatch,
  type Confidence,
  type Entity,
  type GraphData,
  type GraphPatch,
  type RelationCategory,
  type RelFilter,
  type Sector,
} from '@nexus/core';

export type View = 'network' | 'family' | 'path' | 'timeline' | 'review' | 'data';

export type Scope =
  | { kind: 'global' }
  | { kind: 'ego'; id: string; depth: number }
  | { kind: 'dossier'; id: string }
  | { kind: 'path'; ids: string[]; relIds: string[] };

export interface Filters {
  /** 空集合 = 全部 */
  countries: Set<string>;
  sectors: Set<Sector>;
  entityTypes: Set<'person' | 'org'>;
  categories: Set<RelationCategory>;
  minConfidence: Confidence;
  layers: Set<string>;
  showDerived: boolean;
  /** 全局模式下最多显示的节点数（按影响力排序） */
  limit: number;
  /** 只显示在世/在任 */
  livingOnly: boolean;
  /** 节点着色方式 */
  colorBy: 'country' | 'sector' | 'community';
}

export const DEFAULT_CATEGORIES: RelationCategory[] = ['family', 'social', 'political', 'professional', 'financial', 'legal', 'org'];

interface State {
  data?: GraphData;
  index?: NexusIndex;
  loading: boolean;
  error?: string;
  dataVersion: number;
  /** 是否连上本地 API（ctos serve）：在线时可按需加载完整图谱、检索原始仓库、审核匹配 */
  online: boolean;

  view: View;
  selected?: string;
  hovered?: string;
  scope: Scope;
  filters: Filters;
  familyTarget?: { kind: 'person' | 'dossier'; id: string };
  pathA?: string;
  pathB?: string;
  /** 审核视图只看某个实体的候选 */
  reviewEntity?: string;
  showLeft: boolean;
  showRight: boolean;
  /** 个人关注列表（保存在本地浏览器） */
  starred: string[];

  setData(d: GraphData, online?: boolean): void;
  /** 合并按需加载的补丁（新实体/关系） */
  mergePatch(p: GraphPatch): void;
  toggleStar(id: string): void;
  setError(e?: string): void;
  setView(v: View): void;
  select(id?: string): void;
  hover(id?: string): void;
  setScope(s: Scope): void;
  focus(id: string, depth?: number): void;
  openFamily(kind: 'person' | 'dossier', id: string): void;
  openPath(a?: string, b?: string): void;
  patchFilters(p: Partial<Filters>): void;
  toggleIn<K extends keyof Filters>(key: K, value: Filters[K] extends Set<infer T> ? T : never): void;
  togglePanel(side: 'left' | 'right'): void;
}

const STAR_KEY = 'nexus.starred';
function loadStars(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STAR_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

const createStore = () =>
  create<State>((set, get) => ({
  loading: true,
  online: false,
  starred: loadStars(),
  dataVersion: 0,
  view: 'network',
  scope: { kind: 'global' },
  showLeft: true,
  showRight: true,
  filters: {
    countries: new Set(),
    sectors: new Set(),
    entityTypes: new Set(['person', 'org']),
    categories: new Set(DEFAULT_CATEGORIES),
    minConfidence: 'rumor',
    layers: new Set(),
    showDerived: true,
    limit: 700,
    livingOnly: false,
    colorBy: 'country',
  },

  setData(d, online = false) {
    const prev = get();
    set({ data: d, index: new NexusIndex(d), loading: false, error: undefined, online, dataVersion: prev.dataVersion + 1 });
    // 在线模式下选中的实体可能只是尚未加载（由 useRemoteSync 拉取），不清空
    if (!online && prev.selected && !d.entities.some((e) => e.id === prev.selected)) set({ selected: undefined });
  },
  mergePatch(p) {
    const d = get().data;
    if (!d) return;
    const next = mergeGraphPatch(d, p);
    if (next === d) return;
    set({ data: next, index: new NexusIndex(next), dataVersion: get().dataVersion + 1 });
  },
  toggleStar(id) {
    const cur = get().starred;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur];
    set({ starred: next });
    try {
      localStorage.setItem(STAR_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式等情况下忽略 */
    }
  },
  setError(e) {
    set({ error: e, loading: false });
  },
  setView(v) {
    set({ view: v });
  },
  select(id) {
    set({ selected: id, showRight: id ? true : get().showRight });
  },
  hover(id) {
    if (get().hovered !== id) set({ hovered: id });
  },
  setScope(s) {
    set({ scope: s });
  },
  focus(id, depth = 1) {
    set({ scope: { kind: 'ego', id, depth }, selected: id, view: 'network' });
  },
  openFamily(kind, id) {
    set({ familyTarget: { kind, id }, view: 'family', ...(kind === 'person' ? { selected: id } : {}) });
  },
  openPath(a, b) {
    set({ view: 'path', pathA: a ?? get().pathA, pathB: b ?? get().pathB });
  },
  patchFilters(p) {
    set({ filters: { ...get().filters, ...p } });
  },
  toggleIn(key, value) {
    const f = get().filters;
    const cur = new Set(f[key] as Set<unknown>);
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    set({ filters: { ...f, [key]: cur } });
  },
  togglePanel(side) {
    if (side === 'left') set({ showLeft: !get().showLeft });
    else set({ showRight: !get().showRight });
  },
}));

/** 开发模式下跨 HMR 保持同一个 store 实例，避免热更新后界面状态丢失 */
export const useNexus: ReturnType<typeof createStore> = (import.meta.hot?.data.store as ReturnType<typeof createStore> | undefined) ?? createStore();
if (import.meta.hot) import.meta.hot.data.store = useNexus;

if (import.meta.env.DEV) (globalThis as unknown as { __nexus: typeof useNexus }).__nexus = useNexus;

/** 实体是否通过左侧筛选器 */
export function entityPasses(e: Entity, f: Filters): boolean {
  if (f.entityTypes.size && !f.entityTypes.has(e.type)) return false;
  if (f.countries.size && !e.country.some((c) => f.countries.has(c))) return false;
  if (f.sectors.size && !e.sectors.some((s) => f.sectors.has(s))) return false;
  if (f.layers.size && !e.layers.some((l) => f.layers.has(l))) return false;
  if (f.livingOnly && (e.died || e.dissolved)) return false;
  return true;
}

export function relFilterOf(f: Filters): RelFilter {
  return { categories: f.categories, minConfidence: f.minConfidence, excludeDerived: !f.showDerived };
}

// ---------------- URL hash 同步 ----------------
export function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const s = useNexus.getState();
  const view = p.get('view') as View | null;
  const sel = p.get('sel') ?? undefined;
  const patch: Partial<State> = {};
  if (view && ['network', 'family', 'path', 'timeline', 'review', 'data'].includes(view)) patch.view = view;
  if (sel) patch.selected = sel;
  const scope = p.get('scope');
  if (scope) {
    const [kind, id, extra] = scope.split(':');
    if (kind === 'ego' && id) patch.scope = { kind: 'ego', id, depth: Number(extra) || 1 };
    if (kind === 'dossier' && id) patch.scope = { kind: 'dossier', id };
  }
  const fam = p.get('fam');
  if (fam) {
    const [kind, id] = fam.split(':');
    if ((kind === 'person' || kind === 'dossier') && id) patch.familyTarget = { kind, id };
  }
  if (p.get('a')) patch.pathA = p.get('a')!;
  if (p.get('b')) patch.pathB = p.get('b')!;
  useNexus.setState({ ...s, ...patch });
}

export function writeHash() {
  const s = useNexus.getState();
  const p = new URLSearchParams();
  p.set('view', s.view);
  if (s.selected) p.set('sel', s.selected);
  if (s.scope.kind === 'ego') p.set('scope', `ego:${s.scope.id}:${s.scope.depth}`);
  if (s.scope.kind === 'dossier') p.set('scope', `dossier:${s.scope.id}`);
  if (s.view === 'family' && s.familyTarget) p.set('fam', `${s.familyTarget.kind}:${s.familyTarget.id}`);
  if (s.view === 'path') {
    if (s.pathA) p.set('a', s.pathA);
    if (s.pathB) p.set('b', s.pathB);
  }
  const next = '#' + p.toString();
  if (location.hash !== next) history.replaceState(null, '', next);
}
