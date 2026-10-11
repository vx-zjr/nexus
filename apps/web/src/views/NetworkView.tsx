/**
 * 关系网络视图（sigma.js / WebGL）。
 *   全局模式：按影响力取前 N 个节点，坐标来自编译期 ForceAtlas2 布局（稳定的“地图”）
 *   聚焦模式：选中人物的 1~3 跳关系网，局部重新布局
 *   档案模式：某个家族/派系的全部成员
 *   路径模式：两人之间的关系链
 */
import { useEffect, useMemo, useRef } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { CONFIDENCE, RELATION_CATEGORIES, relationDef, type Relation } from '@nexus/core';
import { entityPasses, relFilterOf, useNexus } from '../store/useNexus';
import { nodeColor } from '../lib/format';

const DIM_NODE = '#1a222c';
const DIM_EDGE = 'rgba(40,52,66,0.25)';

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function NetworkView() {
  const { data, index, scope, filters, selected, hovered, dataVersion, starred } = useNexus();
  const select = useNexus((s) => s.select);
  const hover = useNexus((s) => s.hover);
  const focus = useNexus((s) => s.focus);
  const setScope = useNexus((s) => s.setScope);
  const patchFilters = useNexus((s) => s.patchFilters);
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  // ---- 1. 根据 scope + 筛选器选出节点与关系 ----
  const sel = useMemo(() => {
    if (!data || !index) return { nodeIds: new Set<string>(), rels: [] as Relation[], total: 0, sig: '' };
    const rf = relFilterOf(filters);
    let nodeIds: Set<string>;
    let rels: Relation[];
    let total = 0;
    if (scope.kind === 'ego' && index.get(scope.id)) {
      const allow = (e: Parameters<typeof entityPasses>[0]) => entityPasses(e, filters);
      const r = index.ego(scope.id, scope.depth, { ...rf, allow }, 900);
      nodeIds = r.nodes;
      rels = r.relations;
    } else if (scope.kind === 'dossier' && index.dossierById.get(scope.id)) {
      const r = index.dossierGraph(scope.id, rf);
      nodeIds = r.nodes;
      rels = r.relations;
    } else if (scope.kind === 'path') {
      nodeIds = new Set(scope.ids);
      rels = scope.relIds.map((id) => index.relById.get(id)).filter(Boolean) as Relation[];
    } else {
      const pool = data.entities.filter((e) => entityPasses(e, filters));
      total = pool.length;
      pool.sort((a, b) => b.score - a.score || b.degree - a.degree);
      nodeIds = new Set(pool.slice(0, filters.limit).map((e) => e.id));
      if (selected && index.get(selected)) nodeIds.add(selected);
      rels = index.inducedRelations(nodeIds, rf);
    }
    // 签名：按需加载的补丁若没有改变可见节点/关系，就复用原图，避免重建渲染器、镜头跳动
    const sig = `${data.meta.generatedAt}|${total}|${scope.kind}|${filters.colorBy}|${[...nodeIds].sort().join(',')}|${rels.map((r) => r.id).sort().join(',')}`;
    return { nodeIds, rels, total, sig };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, index, scope, filters, dataVersion, scope.kind === 'global' ? selected : null]);

  // ---- 1b. 构建 graphology 图（签名不变则复用） ----
  const { graph, stats } = useMemo(() => {
    const g = new Graph({ type: 'mixed', multi: true });
    if (!index) return { graph: g, stats: { nodes: 0, edges: 0, total: 0 } };
    const { nodeIds, rels, total } = sel;
    const local = scope.kind !== 'global';
    for (const id of nodeIds) {
      const e = index.get(id);
      if (!e) continue;
      const base = e.type === 'org' ? 1.6 : 2;
      g.addNode(id, {
        label: e.name,
        x: e.x ?? Math.random() * 100,
        y: e.y ?? Math.random() * 100,
        size: base + Math.pow(e.score, 1.6) * (e.type === 'org' ? 7 : 11) + (local ? 3 : 0),
        color: nodeColor(e, filters.colorBy),
        nodeType: e.type,
      });
    }
    for (const r of rels) {
      if (!g.hasNode(r.from) || !g.hasNode(r.to)) continue;
      const cat = RELATION_CATEGORIES[r.category];
      const alpha = 0.12 + CONFIDENCE[r.confidence].rank * 0.08;
      g.addDirectedEdgeWithKey(r.id, r.from, r.to, {
        color: hexA(cat.color, r.derived ? alpha * 0.6 : alpha),
        baseColor: cat.color,
        size: r.category === 'family' ? 1.6 : r.derived ? 0.5 : 1,
        label: r.label ?? relationDef(r.type).out,
        relType: r.type,
      });
    }
    // 局部视图：在全局坐标基础上做一次短程力导向，拉开结构
    if (local && g.order > 2 && g.order < 1500) {
      const settings = forceAtlas2.inferSettings(g);
      forceAtlas2.assign(g, { iterations: g.order > 400 ? 120 : 220, settings: { ...settings, gravity: 1, scalingRatio: 6, barnesHutOptimize: g.order > 300, adjustSizes: true } });
    }
    return { graph: g, stats: { nodes: g.order, edges: g.size, total } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.sig]);

  // ---- 2. 创建/更新 sigma 渲染器 ----
  useEffect(() => {
    if (!containerRef.current) return;
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: true,
      labelFont: '"JetBrains Mono", "Noto Sans CJK SC", monospace',
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#cfe3f5' },
      edgeLabelFont: '"JetBrains Mono", "Noto Sans CJK SC", monospace',
      edgeLabelSize: 10,
      edgeLabelColor: { color: '#7fe9ff' },
      labelDensity: 0.6,
      labelGridCellSize: 90,
      labelRenderedSizeThreshold: 7,
      zIndex: true,
      minCameraRatio: 0.03,
      maxCameraRatio: 6,
      defaultDrawNodeHover: (ctx, d, settings) => {
        const size = settings.labelSize;
        ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
        const label = d.label ?? '';
        const w = ctx.measureText(label).width + 12;
        const x = d.x + d.size + 4, y = d.y - size / 2 - 5;
        ctx.fillStyle = 'rgba(7,10,14,0.92)';
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, w, size + 10);
        ctx.strokeRect(x, y, w, size + 10);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.size + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e6f1ff';
        ctx.fillText(label, x + 6, d.y + size / 3);
      },
    });
    sigmaRef.current = renderer;
    if (import.meta.env.DEV) (window as unknown as { __nexusSigma: Sigma }).__nexusSigma = renderer;
    renderer.on('clickNode', ({ node }) => select(node));
    renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
      preventSigmaDefault();
      focus(node, 1);
    });
    renderer.on('enterNode', ({ node }) => hover(node));
    renderer.on('leaveNode', () => hover(undefined));
    renderer.on('clickStage', () => select(undefined));
    return () => {
      renderer.kill();
      sigmaRef.current = null;
    };
  }, [graph, select, hover, focus]);

  // ---- 3. 高亮：悬停/选中节点及其邻居 ----
  useEffect(() => {
    const r = sigmaRef.current;
    if (!r) return;
    const center = hovered ?? selected;
    const focusSet = new Set<string>();
    if (center && graph.hasNode(center)) {
      focusSet.add(center);
      graph.forEachNeighbor(center, (n) => focusSet.add(n));
    }
    const pathMode = scope.kind === 'path';
    const stars = new Set(starred);
    r.setSetting('nodeReducer', (node, attrs) => {
      const out = { ...attrs };
      if (stars.has(node)) {
        out.forceLabel = true;
        out.label = `★ ${attrs.label}`;
      }
      if (node === selected) {
        out.highlighted = true;
        out.forceLabel = true;
        out.zIndex = 3;
      }
      if (focusSet.size) {
        if (focusSet.has(node)) {
          out.forceLabel = true;
          out.zIndex = 2;
        } else {
          out.color = DIM_NODE;
          out.label = '';
          out.zIndex = 0;
        }
      }
      if (pathMode) out.forceLabel = true;
      return out;
    });
    r.setSetting('edgeReducer', (edge, attrs) => {
      const out = { ...attrs };
      const [s, t] = graph.extremities(edge);
      const adj = center !== undefined && (s === center || t === center);
      if (focusSet.size && !adj) {
        out.color = DIM_EDGE;
        out.label = '';
      } else if (adj || pathMode) {
        out.color = hexA(attrs.baseColor as string, 0.95);
        out.size = (attrs.size as number) + 1;
        out.forceLabel = true;
      } else {
        out.label = '';
      }
      return out;
    });
  }, [graph, hovered, selected, scope.kind, starred]);

  // ---- 4. 选中节点时镜头跟随 ----
  useEffect(() => {
    const r = sigmaRef.current;
    if (!r || !selected || !graph.hasNode(selected)) return;
    const d = r.getNodeDisplayData(selected);
    if (!d) return;
    // 显示数据是图坐标，相机使用归一化的 framed 坐标，需要转换
    const framed = r.viewportToFramedGraph(r.graphToViewport({ x: d.x, y: d.y }));
    r.getCamera().animate({ x: framed.x, y: framed.y, ratio: Math.min(r.getCamera().ratio, scope.kind === 'global' ? 0.35 : 0.8) }, { duration: 450 });
  }, [selected, graph, scope.kind]);

  const zoom = (k: number) => {
    const cam = sigmaRef.current?.getCamera();
    if (!cam) return;
    if (k === 0) cam.animatedReset({ duration: 300 });
    else if (k > 0) cam.animatedZoom({ duration: 200 });
    else cam.animatedUnzoom({ duration: 200 });
  };

  const scopeLabel =
    scope.kind === 'global'
      ? 'GLOBAL'
      : scope.kind === 'ego'
        ? `EGO · ${index?.get(scope.id)?.name ?? scope.id} · ${scope.depth} HOP`
        : scope.kind === 'dossier'
          ? `DOSSIER · ${index?.dossierById.get(scope.id)?.name ?? scope.id}`
          : `PATH · ${scope.ids.length} NODES`;

  return (
    <div className="relative h-full w-full grid-bg scanlines">
      <div ref={containerRef} className="absolute inset-0" />

      {/* HUD：范围与控制 */}
      <div className="absolute left-3 top-3 flex flex-col gap-2">
        <div className="panel brackets px-3 py-2">
          <div className="hud-title">scope</div>
          <div className="mono text-[12px] text-cyan glow">{scopeLabel}</div>
          <div className="mono text-[11px] text-ink-3">
            {stats.nodes} nodes · {stats.edges} links{scope.kind === 'global' && stats.total ? ` · of ${stats.total}` : ''}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {scope.kind !== 'global' && (
            <button className="btn" onClick={() => setScope({ kind: 'global' })}>
              ◂ 全局
            </button>
          )}
          {scope.kind === 'ego' &&
            [1, 2, 3].map((d) => (
              <button key={d} className={`btn ${scope.depth === d ? 'active' : ''}`} onClick={() => setScope({ ...scope, depth: d })}>
                {d} 跳
              </button>
            ))}
          {scope.kind === 'global' && selected && (
            <button className="btn" onClick={() => focus(selected, 1)}>
              ◎ 聚焦选中
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {(['country', 'sector', 'community'] as const).map((m) => (
            <button key={m} className={`btn ${filters.colorBy === m ? 'active' : ''}`} onClick={() => patchFilters({ colorBy: m })}>
              {m === 'country' ? '按国家' : m === 'sector' ? '按领域' : '按社区'}
            </button>
          ))}
        </div>
        {scope.kind === 'global' && (
          <div className="panel px-3 py-2 w-56">
            <div className="hud-title flex justify-between">
              <span>节点上限</span>
              <span className="text-ink-2">{filters.limit >= 99999 ? 'ALL' : filters.limit}</span>
            </div>
            <input
              type="range"
              min={100}
              max={Math.max(200, (stats.total || 3000) + 100)}
              step={100}
              value={Math.min(filters.limit, (stats.total || 3000) + 100)}
              onChange={(e) => {
                const v = Number(e.target.value);
                patchFilters({ limit: v > (stats.total || 3000) ? 99999 : v });
              }}
              className="w-full"
            />
          </div>
        )}
      </div>

      {/* 图例 */}
      <div className="absolute left-3 bottom-3 panel px-3 py-2 text-[11px] mono">
        <div className="hud-title mb-1">legend</div>
        <div className="flex gap-3 mb-1">
          <span><i className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: '#ff4d5e' }} />中国</span>
          <span><i className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: '#3b9cff' }} />美国</span>
          <span><i className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: '#b8c2cc' }} />其他</span>
          <span className="text-ink-3">机构=领域色</span>
        </div>
        <div className="flex flex-wrap gap-x-3 max-w-[340px]">
          {Object.entries(RELATION_CATEGORIES).map(([k, v]) => (
            <span key={k}>
              <i className="inline-block w-3 h-[2px] mr-1 align-middle" style={{ background: v.color }} />
              {v.zh}
            </span>
          ))}
        </div>
        <div className="text-ink-3 mt-1">单击=档案 · 双击=聚焦关系网 · 滚轮=缩放</div>
      </div>

      <div className="absolute right-3 bottom-3 flex flex-col gap-1">
        <button className="btn justify-center" onClick={() => zoom(1)}>＋</button>
        <button className="btn justify-center" onClick={() => zoom(-1)}>－</button>
        <button className="btn justify-center" onClick={() => zoom(0)}>⟲</button>
      </div>
    </div>
  );
}
