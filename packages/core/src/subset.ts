/**
 * 子图工具。大体量数据层（layers.yaml 中 bulk: true）接入后完整图谱可达十万级节点：
 * 浏览器默认只加载“核心子图”，其余实体与关系按需经本地 API（tools/cli/src/server.ts）以补丁形式拉取并合并。
 */
import type { Entity, GraphData, Relation } from './types.ts';

/** 一次按需查询返回的补丁：若干实体 + 关系（关系两端的实体都包含在内或已在本地） */
export interface GraphPatch {
  entities: Entity[];
  relations: Relation[];
}

/** 核心实体：出现在任一非 bulk 层，或 tier ≤ maxTier，或属于某个档案 */
export function coreIds(data: GraphData, maxTier = 3): Set<string> {
  const bulk = new Set(data.meta.layers.filter((l) => l.bulk).map((l) => l.id));
  const ids = new Set<string>();
  for (const e of data.entities) {
    if ((e.tier ?? 5) <= maxTier || e.layers.some((l) => !bulk.has(l)) || e.dossiers.length) ids.add(e.id);
  }
  return ids;
}

/** 由实体集合导出子图（关系取两端都在集合内者；档案全部保留） */
export function subsetGraph(data: GraphData, ids: Set<string>, maxTier = 3): GraphData {
  return {
    ...data,
    meta: { ...data.meta, subset: { kind: 'core', maxTier, full: { entities: data.entities.length, relations: data.relations.length } } },
    entities: data.entities.filter((e) => ids.has(e.id)),
    relations: data.relations.filter((r) => ids.has(r.from) && ids.has(r.to)),
  };
}

/** 由实体 id 集合与关系列表构造补丁 */
export function makePatch(get: (id: string) => Entity | undefined, ids: Iterable<string>, relations: Relation[]): GraphPatch {
  const all = new Set(ids);
  for (const r of relations) {
    all.add(r.from);
    all.add(r.to);
  }
  return { entities: [...all].map(get).filter(Boolean) as Entity[], relations };
}

/**
 * 把补丁合并进图（返回新数据对象，不修改原数据）。没有坐标的新实体放到已有邻居附近。
 * @returns 新增实体/关系数为 0 时返回原对象
 */
export function mergePatch(data: GraphData, patch: GraphPatch): GraphData {
  const have = new Map(data.entities.map((e) => [e.id, e]));
  const relIds = new Set(data.relations.map((r) => r.id));
  const newEnts = patch.entities.filter((e) => !have.has(e.id));
  const newRels = patch.relations.filter((r) => !relIds.has(r.id));
  if (!newEnts.length && !newRels.length) return data;
  for (const e of newEnts) have.set(e.id, e);
  const nb = new Map<string, string[]>();
  for (const r of [...data.relations, ...newRels]) {
    (nb.get(r.from) ?? nb.set(r.from, []).get(r.from)!).push(r.to);
    (nb.get(r.to) ?? nb.set(r.to, []).get(r.to)!).push(r.from);
  }
  for (const e of newEnts) {
    if (e.x !== undefined && e.y !== undefined) continue;
    const anchors = (nb.get(e.id) ?? []).map((id) => have.get(id)).filter((n) => n?.x !== undefined) as Entity[];
    const h = [...e.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const jx = ((h % 1000) / 1000 - 0.5) * 60, jy = (((h >>> 10) % 1000) / 1000 - 0.5) * 60;
    if (anchors.length) {
      e.x = anchors.reduce((s, n) => s + n.x!, 0) / anchors.length + jx;
      e.y = anchors.reduce((s, n) => s + n.y!, 0) / anchors.length + jy;
    } else {
      e.x = jx * 20;
      e.y = jy * 20;
    }
  }
  return { ...data, entities: [...data.entities, ...newEnts], relations: [...data.relations, ...newRels] };
}
