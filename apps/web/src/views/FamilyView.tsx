/**
 * 家族/档案视图：族谱式分层布局（dagre）。
 *   - 夫妻之间插入“婚姻节点”，子女挂在婚姻节点下 —— 经典族谱画法
 *   - 无共同父母的兄弟姐妹挂在一个虚拟节点下，保证同代对齐
 *   - 姻亲/秘书/持股等非血缘关系以虚线叠加，不参与分层
 * 这正是 zhao 项目“一族一档”的可视化方式，只是改成可交互的。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { CONFIDENCE, FAMILY_TYPES, RELATION_CATEGORIES, relationDef, type Entity, type Relation } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { entityColor, lifeSpan, shortSummary, statusLabel } from '../lib/format';
import { EntityPicker } from '../components/EntityPicker';
import { ensureFamily } from '../lib/api';

const NW = 176;
const NH = 60;
const PAIR = new Set(['spouse', 'ex-spouse', 'partner']);

interface LNode {
  id: string;
  x: number;
  y: number;
  kind: 'entity' | 'union' | 'virtual';
  e?: Entity;
  outer?: boolean;
}
interface LEdge {
  key: string;
  points: { x: number; y: number }[];
  kind: 'parent' | 'pair' | 'sib' | 'link';
  rel?: Relation;
}

function buildLayout(entities: Entity[], rels: Relation[], outer: Set<string>, showOther: boolean) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 46, edgesep: 10, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(entities.map((e) => e.id));
  for (const e of entities) g.setNode(e.id, { width: NW, height: NH });

  const fam = rels.filter((r) => FAMILY_TYPES.has(r.type));
  const unions = new Map<string, { a: string; b: string; rel: Relation }>();
  for (const r of fam) {
    if (!PAIR.has(r.type)) continue;
    const [a, b] = [r.from, r.to].sort();
    const key = `u:${a}|${b}`;
    if (unions.has(key)) continue;
    unions.set(key, { a, b, rel: r });
    g.setNode(key, { width: 10, height: 10 });
    g.setEdge(a, key, { minlen: 1, weight: 4 }, `pa:${key}`);
    g.setEdge(b, key, { minlen: 1, weight: 4 }, `pb:${key}`);
  }
  const parentsOf = new Map<string, string[]>();
  for (const r of fam) if (r.type === 'parent') (parentsOf.get(r.to) ?? parentsOf.set(r.to, []).get(r.to)!).push(r.from);
  const parentEdges: { key: string; child: string; via: string; rel?: Relation }[] = [];
  for (const [child, ps] of parentsOf) {
    let placed = false;
    if (ps.length >= 2) {
      for (let i = 0; i < ps.length && !placed; i++)
        for (let j = i + 1; j < ps.length && !placed; j++) {
          const [a, b] = [ps[i], ps[j]].sort();
          const key = `u:${a}|${b}`;
          if (unions.has(key)) {
            g.setEdge(key, child, { minlen: 1, weight: 2 }, `c:${key}>${child}`);
            parentEdges.push({ key: `c:${key}>${child}`, child, via: key });
            placed = true;
          }
        }
    }
    if (!placed)
      for (const p of ps) {
        g.setEdge(p, child, { minlen: 2, weight: 2 }, `c:${p}>${child}`);
        parentEdges.push({ key: `c:${p}>${child}`, child, via: p, rel: fam.find((r) => r.type === 'parent' && r.from === p && r.to === child) });
      }
  }
  // 兄弟姐妹：无共同父母时挂到虚拟节点
  const sibParent = new Map<string, string>();
  const find = (x: string): string => (sibParent.get(x) && sibParent.get(x) !== x ? (sibParent.set(x, find(sibParent.get(x)!)), sibParent.get(x)!) : x);
  for (const r of fam) {
    if (r.type !== 'sibling') continue;
    const pa = parentsOf.get(r.from) ?? [], pb = parentsOf.get(r.to) ?? [];
    if (pa.some((p) => pb.includes(p))) continue;
    if (!sibParent.has(r.from)) sibParent.set(r.from, r.from);
    if (!sibParent.has(r.to)) sibParent.set(r.to, r.to);
    sibParent.set(find(r.to), find(r.from));
  }
  const sibGroups = new Map<string, string[]>();
  for (const x of sibParent.keys()) (sibGroups.get(find(x)) ?? sibGroups.set(find(x), []).get(find(x))!).push(x);
  for (const [root, members] of sibGroups) {
    if (members.length < 2) continue;
    const v = `v:${root}`;
    g.setNode(v, { width: 4, height: 4 });
    for (const m of members) g.setEdge(v, m, { minlen: 1, weight: 1 }, `s:${v}>${m}`);
  }
  // 机构：挂在相关人物下方
  for (const r of rels) {
    if (FAMILY_TYPES.has(r.type)) continue;
    const fe = entities.find((e) => e.id === r.from), te = entities.find((e) => e.id === r.to);
    if (fe?.type === 'person' && te?.type === 'org' && !g.hasEdge(r.from, r.to)) g.setEdge(r.from, r.to, { minlen: 1, weight: 1 }, `o:${r.id}`);
  }
  dagre.layout(g);

  const nodes: LNode[] = [];
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (!n) continue;
    if (ids.has(id)) nodes.push({ id, x: n.x, y: n.y, kind: 'entity', e: entities.find((e) => e.id === id), outer: outer.has(id) });
    else nodes.push({ id, x: n.x, y: n.y, kind: id.startsWith('u:') ? 'union' : 'virtual' });
  }
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const edges: LEdge[] = [];
  for (const [key, u] of unions) {
    const un = pos.get(key)!;
    for (const p of [u.a, u.b]) {
      const pn = pos.get(p)!;
      edges.push({ key: `${key}-${p}`, kind: 'pair', rel: u.rel, points: [{ x: pn.x, y: pn.y + NH / 2 }, { x: pn.x, y: un.y }, { x: un.x, y: un.y }] });
    }
  }
  for (const pe of parentEdges) {
    const a = pos.get(pe.via)!, c = pos.get(pe.child)!;
    const y0 = a.kind === 'union' ? a.y : a.y + NH / 2;
    const mid = (y0 + c.y - NH / 2) / 2;
    edges.push({ key: pe.key, kind: 'parent', rel: pe.rel, points: [{ x: a.x, y: y0 }, { x: a.x, y: mid }, { x: c.x, y: mid }, { x: c.x, y: c.y - NH / 2 }] });
  }
  for (const [root, members] of sibGroups) {
    const v = pos.get(`v:${root}`);
    if (!v || members.length < 2) continue;
    for (const m of members) {
      const c = pos.get(m)!;
      edges.push({ key: `s:${root}>${m}`, kind: 'sib', points: [{ x: v.x, y: v.y }, { x: c.x, y: v.y }, { x: c.x, y: c.y - NH / 2 }] });
    }
  }
  for (const r of rels) {
    if (r.type === 'parent' || PAIR.has(r.type) || r.type === 'sibling') continue;
    if (!showOther && !FAMILY_TYPES.has(r.type) && !(pos.get(r.to)?.e?.type === 'org')) continue;
    const a = pos.get(r.from), b = pos.get(r.to);
    if (!a || !b) continue;
    edges.push({ key: `l:${r.id}`, kind: 'link', rel: r, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] });
  }
  const gl = g.graph();
  return { nodes, edges, width: gl.width ?? 800, height: gl.height ?? 600 };
}

export function FamilyView() {
  const { index, familyTarget, selected, dataVersion, online } = useNexus();
  const select = useNexus((s) => s.select);
  const openFamily = useNexus((s) => s.openFamily);
  const focus = useNexus((s) => s.focus);
  const [depth, setDepth] = useState(2);
  const [showOther, setShowOther] = useState(true);
  const [dq, setDq] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const target = familyTarget ?? (selected ? { kind: 'person' as const, id: selected } : undefined);
  // 在线模式：按需拉取完整的家族网络（含尚未加载的亲属）
  useEffect(() => {
    if (online && target?.kind === 'person') void ensureFamily(target.id, depth);
  }, [online, target?.kind, target?.id, depth]);

  const sub = useMemo(() => {
    if (!index || !target) return null;
    if (target.kind === 'dossier') {
      const d = index.dossierById.get(target.id);
      if (!d) return null;
      const g = index.dossierGraph(d.id);
      return { title: d.name, sub: `${d.kind} · ${d.members.length} 人`, nodes: g.nodes, rels: g.relations, outer: new Set(d.members.filter((m) => m.role === 'outer').map((m) => m.id)), dossier: d };
    }
    const e = index.get(target.id);
    if (!e) return null;
    const g = index.family(e.id, depth);
    // 补充家族成员之间的非亲属关系（姻亲公司、秘书等）
    const extra = showOther ? index.inducedRelations(g.nodes).filter((r) => !FAMILY_TYPES.has(r.type) && !r.derived) : [];
    return { title: `${e.name} · 家族网络`, sub: `${depth} 层亲属 · ${g.nodes.size} 人`, nodes: g.nodes, rels: [...g.relations, ...extra], outer: new Set<string>(), dossier: undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, target?.kind, target?.id, depth, showOther, dataVersion]);

  const layout = useMemo(() => {
    if (!sub || !index) return null;
    const ents = [...sub.nodes].map((id) => index.get(id)).filter(Boolean) as Entity[];
    if (ents.length > 350) return { tooBig: ents.length } as const;
    return buildLayout(ents, sub.rels, sub.outer, showOther);
  }, [sub, index, showOther]);

  // 自适应缩放：整体可见；过宽时保持可读（≥0.55）并以核心人物为中心
  useEffect(() => {
    if (!layout || 'tooBig' in layout || !svgRef.current) return;
    const { clientWidth: w, clientHeight: h } = svgRef.current;
    const fit = Math.min(w / layout.width, (h - 120) / layout.height) * 0.95;
    const k = Math.max(0.55, Math.min(1.15, fit));
    const focusId = sub?.dossier?.head ?? (target?.kind === 'person' ? target.id : undefined);
    const fn = focusId ? layout.nodes.find((n) => n.id === focusId) : undefined;
    if (fit >= 0.55 || !fn) setView({ k, x: (w - layout.width * k) / 2, y: Math.max(130, (h - layout.height * k) / 2 + 60) });
    else setView({ k, x: w / 2 - fn.x * k, y: 150 - (fn.y - NH) * k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const onWheel = (ev: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const k = Math.max(0.1, Math.min(3, v.k * f));
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };

  const dossiers = useMemo(() => {
    if (!index) return [];
    const q = dq.trim().toLowerCase();
    return index.data.dossiers.filter((d) => !q || d.name.toLowerCase().includes(q) || d.id.includes(q) || d.tags.some((t) => t.toLowerCase().includes(q))).slice(0, 200);
  }, [index, dq]);

  return (
    <div className="relative h-full w-full grid-bg flex">
      {/* 档案列表 */}
      <div className="w-60 shrink-0 border-r border-line flex flex-col bg-panel/80">
        <div className="p-2 border-b border-line">
          <div className="hud-title mb-1">dossiers · 家族/派系档案</div>
          <input className="input w-full" placeholder="过滤档案…" value={dq} onChange={(e) => setDq(e.target.value)} />
        </div>
        <div className="flex-1 overflow-auto">
          {dossiers.map((d) => (
            <div
              key={d.id}
              onClick={() => openFamily('dossier', d.id)}
              className={`px-3 py-1.5 cursor-pointer border-l-2 hover:bg-white/5 ${target?.kind === 'dossier' && target.id === d.id ? 'border-cyan bg-cyan/5' : 'border-transparent'}`}
            >
              <div className="text-[12.5px]">{d.name}</div>
              <div className="mono text-[10px] text-ink-3">
                {d.kind} · {d.members.length} · {d.tags.filter((t) => t !== 'zhao').slice(0, 2).join(' ')}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="relative flex-1">
        <div className="absolute left-3 top-3 z-10 flex flex-col gap-2">
          <div className="panel brackets px-3 py-2 min-w-64">
            <div className="hud-title">family / dossier</div>
            <div className="text-[14px] text-cyan glow">{sub?.title ?? '选择一个人物或档案'}</div>
            <div className="mono text-[11px] text-ink-3">{sub?.sub}</div>
          </div>
          <div className="flex gap-1 flex-wrap items-center">
            <EntityPicker placeholder="查人物的家族…" onPick={(id) => openFamily('person', id)} />
            {target?.kind === 'person' &&
              [1, 2, 3, 4].map((d) => (
                <button key={d} className={`btn ${depth === d ? 'active' : ''}`} onClick={() => setDepth(d)}>
                  {d} 层
                </button>
              ))}
            <button className={`btn ${showOther ? 'active' : ''}`} onClick={() => setShowOther(!showOther)}>
              非血缘关系
            </button>
            {target && (
              <button className="btn" onClick={() => (target.kind === 'dossier' ? useNexus.getState().setScope({ kind: 'dossier', id: target.id }) : focus(target.id, 2), useNexus.getState().setView('network'))}>
                ⇢ 网络图
              </button>
            )}
          </div>
          {sub?.dossier?.summary && (
            <details className="panel px-3 py-2 max-w-md text-[12px] text-ink-2">
              <summary className="hud-title cursor-pointer">brief · 档案摘要</summary>
              <div className="whitespace-pre-wrap mt-1 leading-relaxed">{sub.dossier.summary}</div>
              {sub.dossier.sources.length > 0 && (
                <div className="mt-2 flex flex-col gap-0.5">
                  {sub.dossier.sources.slice(0, 6).map((s, i) => (
                    <a key={i} className="link text-[11px] truncate" href={s.url} target="_blank" rel="noreferrer">↗ {s.title ?? s.publisher ?? s.url}</a>
                  ))}
                </div>
              )}
            </details>
          )}
        </div>

        {!target && <div className="absolute inset-0 flex items-center justify-center text-ink-3 mono">← 从左侧选择档案，或搜索一个人物</div>}
        {layout && 'tooBig' in layout && <div className="absolute inset-0 flex items-center justify-center text-amber mono">该网络有 {layout.tooBig} 人，过大，请减少层数</div>}

        {layout && !('tooBig' in layout) && (
          <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing select-none"
            onWheel={onWheel}
            onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y })}
            onMouseMove={(e) => drag.current && setView((v) => ({ ...v, x: drag.current!.vx + e.clientX - drag.current!.x, y: drag.current!.vy + e.clientY - drag.current!.y }))}
            onMouseUp={() => (drag.current = null)}
            onMouseLeave={() => (drag.current = null)}
          >
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {layout.edges.map((ed) => {
                const d = ed.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
                const low = ed.rel && CONFIDENCE[ed.rel.confidence].rank <= 2;
                const stroke =
                  ed.kind === 'pair' ? (ed.rel?.type === 'spouse' ? '#ff4d5e' : '#a35a64') : ed.kind === 'link' ? RELATION_CATEGORIES[ed.rel!.category].color : '#5f7387';
                const mid = ed.points[Math.floor(ed.points.length / 2)];
                const prev = ed.points[Math.floor(ed.points.length / 2) - 1] ?? mid;
                const lbl = ed.kind === 'link' ? (ed.rel?.label ?? relationDef(ed.rel!.type).out) : ed.kind === 'pair' && ed.rel?.type !== 'spouse' ? relationDef(ed.rel!.type).out : ed.kind === 'parent' ? ed.rel?.label : undefined;
                return (
                  <g key={ed.key}>
                    <path
                      d={d}
                      fill="none"
                      stroke={stroke}
                      strokeOpacity={ed.kind === 'link' ? 0.7 : 0.9}
                      strokeWidth={ed.kind === 'pair' ? 2 : 1.4}
                      strokeDasharray={ed.kind === 'link' || low ? '5 4' : ed.kind === 'sib' ? '2 3' : undefined}
                    />
                    {lbl && (
                      <text x={(mid.x + prev.x) / 2} y={(mid.y + prev.y) / 2 - 3} fill="#9fb3c8" fontSize={10} textAnchor="middle" className="mono">
                        {lbl}
                      </text>
                    )}
                  </g>
                );
              })}
              {layout.nodes.map((n) => {
                if (n.kind === 'union') return <rect key={n.id} x={n.x - 4} y={n.y - 4} width={8} height={8} transform={`rotate(45 ${n.x} ${n.y})`} fill="#ff4d5e" />;
                if (n.kind === 'virtual') return <circle key={n.id} cx={n.x} cy={n.y} r={2} fill="#5f7387" />;
                const e = n.e!;
                const sel = e.id === selected;
                const dead = !!e.died || !!e.dissolved;
                const bad = e.status === 'purged' || e.status === 'detained' || e.status === 'investigated';
                return (
                  <g key={n.id} transform={`translate(${n.x - NW / 2},${n.y - NH / 2})`} className="cursor-pointer" onClick={(ev) => (ev.stopPropagation(), select(e.id))} onDoubleClick={() => e.type === 'person' && openFamily('person', e.id)}>
                    <rect width={NW} height={NH} fill={sel ? '#0d2a31' : '#0d131a'} stroke={sel ? '#00e5ff' : n.outer ? '#3a4a5a' : '#2a3846'} strokeDasharray={n.outer ? '4 3' : undefined} strokeWidth={sel ? 1.6 : 1} filter={sel ? 'url(#glow)' : undefined} rx={e.type === 'org' ? 0 : 3} />
                    <rect width={3} height={NH} fill={entityColor(e)} />
                    <text x={10} y={18} fill={dead ? '#8aa0b4' : '#e6f1ff'} fontSize={13} fontWeight={600}>
                      {e.name.length > 12 ? e.name.slice(0, 12) + '…' : e.name}
                      <tspan fill="#5c6b7a" fontSize={10} className="mono">
                        {'  '}
                        {lifeSpan(e)}
                      </tspan>
                    </text>
                    <text x={10} y={34} fill="#7f93a8" fontSize={10.5}>
                      {shortSummary(e, 15)}
                    </text>
                    <text x={10} y={50} fill="#5c6b7a" fontSize={9.5} className="mono">
                      {e.names.en && e.names.en !== e.name ? (e.names.en.length > 22 ? e.names.en.slice(0, 22) + '…' : e.names.en) : e.id.slice(0, 24)}
                    </text>
                    {bad && (
                      <g transform={`translate(${NW - 40},4)`}>
                        <rect width={36} height={14} fill="#3a0d14" stroke="#ff3b4e" />
                        <text x={18} y={10.5} fill="#ff3b4e" fontSize={9} textAnchor="middle">
                          {statusLabel(e.status).slice(0, 3)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        <div className="absolute right-3 bottom-3 panel px-3 py-2 text-[11px] mono text-ink-2">
          <div><span className="text-red">◆</span> 婚姻 · 实线=亲子 · 点线=同胞 · 虚线=非血缘/待核实</div>
          <div className="text-ink-3">单击=档案 · 双击=以此人为中心 · 滚轮缩放 · 拖拽平移</div>
        </div>
      </div>
    </div>
  );
}
