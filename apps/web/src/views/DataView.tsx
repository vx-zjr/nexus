/**
 * 数据中心：规模统计、数据层、质量问题、研究待办。
 * “研究待办”是给 AI 代理的任务清单：影响力高但资料薄弱的人物优先补充。
 */
import { useEffect, useMemo, useState } from 'react';
import { CONFIDENCE, COUNTRIES, RELATION_CATEGORIES, SECTORS, exportGraph, type ExportFormat, type GraphData } from '@nexus/core';

function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAs(data: GraphData, fmt: ExportFormat | 'json') {
  if (fmt === 'json') return download('nexus-graph.json', JSON.stringify(data), 'application/json');
  const files = exportGraph(data, fmt);
  for (const [name, content] of Object.entries(files)) download(name.replace(/\//g, '_'), content);
}
import { useNexus } from '../store/useNexus';
import { entityColor } from '../lib/format';

/** 原始数据仓库状态（需本地 API） */
function WarehousePanel() {
  const online = useNexus((s) => s.online);
  const [rows, setRows] = useState<{ source: string; version: string; ingested_at: string; license: string; note: string; tables: string }[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!online) return;
    fetch('/api/warehouse/status')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`))))
      .then(setRows)
      .catch((e: Error) => setErr(e.message));
  }, [online]);
  if (!online) return null;
  return (
    <div className="col-span-12 panel p-4">
      <div className="hud-title mb-2">warehouse · 原始数据仓库（data/warehouse/nexus.duckdb，详见 docs/warehouse.md）</div>
      {err && <div className="mono text-[11px] text-amber">仓库暂不可用：{err}（入库进行中时会被锁定）</div>}
      {rows && !rows.length && <div className="mono text-[11px] text-ink-3">尚未入库：npm run ctos -- warehouse fetch && npm run ctos -- warehouse ingest all</div>}
      {rows && rows.length > 0 && (
        <table className="w-full text-[12px]">
          <thead className="text-ink-3 mono text-[10.5px] text-left">
            <tr><th className="py-1">来源</th><th>版本</th><th>入库时间</th><th>表（行数）</th><th>许可</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source} className="border-t border-line align-top">
                <td className="mono text-cyan py-1">{r.source}</td>
                <td className="mono text-ink-2">{r.version || '—'}</td>
                <td className="mono text-ink-3">{r.ingested_at?.slice(0, 16).replace('T', ' ')}</td>
                <td className="mono text-[11px] text-ink-2">
                  {Object.entries(JSON.parse(r.tables || '{}') as Record<string, number>).map(([k, v]) => `${k} ${Number(v).toLocaleString()}`).join(' · ')}
                </td>
                <td className="text-[11px] text-ink-3">{r.license}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Bars({ data, labels, colors }: { data: Record<string, number>; labels?: Record<string, { zh: string }>; colors?: Record<string, { color: string }> }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 text-[11.5px]">
          <span className="w-24 truncate text-ink-2">{labels?.[k]?.zh ?? k}</span>
          <div className="flex-1 h-2 bg-line/60">
            <div className="h-full" style={{ width: `${(v / max) * 100}%`, background: colors?.[k]?.color ?? '#00e5ff', opacity: 0.85 }} />
          </div>
          <span className="mono w-12 text-right text-ink-3">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function DataView() {
  const { data, index } = useNexus();
  const select = useNexus((s) => s.select);
  const [level, setLevel] = useState<'error' | 'warn' | 'info'>('error');
  const [tab, setTab] = useState<'todo' | 'issues' | 'top'>('todo');

  const todo = useMemo(() => {
    if (!data || !index) return [];
    return data.entities
      .filter((e) => e.type === 'person')
      .map((e) => {
        const rels = index.relationsOf(e.id).filter((r) => !r.derived);
        const gaps: string[] = [];
        if (!e.summary) gaps.push('无简介');
        if (!e.layers.includes('curated')) gaps.push('未精编');
        if (!rels.some((r) => r.category === 'family')) gaps.push('无家族关系');
        if (e.sources.length + e.links.length < 2) gaps.push('来源<2');
        if (rels.some((r) => CONFIDENCE[r.confidence].rank <= 2)) gaps.push('含待核实关系');
        return { e, gaps, prio: e.score * (gaps.length + 1) };
      })
      .filter((x) => x.gaps.length)
      .sort((a, b) => b.prio - a.prio)
      .slice(0, 150);
  }, [data, index]);

  if (!data) return null;
  const c = data.meta.counts;
  const issues = data.issues.filter((i) => i.level === level);

  return (
    <div className="h-full w-full grid-bg overflow-auto">
      <div className="max-w-6xl mx-auto p-6 grid grid-cols-12 gap-4">
        <div className="col-span-12 grid grid-cols-6 gap-3">
          {[
            ['实体', c.entities],
            ['人物', c.persons],
            ['机构', c.orgs],
            ['关系', c.relations],
            ['档案', c.dossiers],
            ['来源', c.sources],
          ].map(([k, v]) => (
            <div key={k} className="panel brackets px-4 py-3">
              <div className="hud-title">{k}</div>
              <div className="mono text-2xl text-cyan glow">{Number(v).toLocaleString()}</div>
            </div>
          ))}
        </div>

        <div className="col-span-4 panel p-4">
          <div className="hud-title mb-2">国家/地区</div>
          <Bars data={Object.fromEntries(Object.entries(c.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10))} labels={COUNTRIES} colors={COUNTRIES} />
        </div>
        <div className="col-span-4 panel p-4">
          <div className="hud-title mb-2">领域</div>
          <Bars data={c.bySector} labels={SECTORS} colors={SECTORS} />
        </div>
        <div className="col-span-4 panel p-4 flex flex-col gap-4">
          <div>
            <div className="hud-title mb-2">关系类别</div>
            <Bars data={c.byCategory} labels={RELATION_CATEGORIES} colors={RELATION_CATEGORIES} />
          </div>
          <div>
            <div className="hud-title mb-2">可信度</div>
            <Bars data={c.byConfidence} labels={CONFIDENCE} />
          </div>
        </div>

        <div className="col-span-12 panel p-4">
          <div className="hud-title mb-2">数据层（按优先级合并，精编层覆盖导入层）</div>
          <table className="w-full text-[12px]">
            <thead className="text-ink-3 mono text-[10.5px] text-left">
              <tr><th className="py-1">ID</th><th>名称</th><th>优先级</th><th>实体</th><th>关系</th><th>许可</th><th>说明</th></tr>
            </thead>
            <tbody>
              {data.meta.layers.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="mono text-cyan py-1">{l.id}</td><td>{l.name}</td><td className="mono">{l.priority}</td>
                  <td className="mono">{l.entityCount}</td><td className="mono">{l.relationCount}</td><td className="mono text-ink-3">{l.license ?? '—'}</td>
                  <td className="text-ink-2">{l.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mono text-[10.5px] text-ink-3 mt-2">编译于 {new Date(data.meta.generatedAt).toLocaleString()} · schema v{data.meta.schemaVersion}</div>
          <div className="flex flex-wrap items-center gap-1 mt-3">
            <span className="hud-title mr-2">export · 导出已加载的子图</span>
            {(['json', 'csv', 'graphml', 'gexf', 'cypher', 'jsonl', 'ftm'] as const).map((f) => (
              <button key={f} className="btn" onClick={() => exportAs(data, f)} title={f === 'gexf' ? 'Gephi' : f === 'cypher' ? 'Neo4j' : f === 'graphml' ? 'yEd / Cytoscape / NetworkX' : f === 'jsonl' ? 'LLM / RAG' : f === 'ftm' ? 'FollowTheMoney：OCCRP Aleph / OpenSanctions' : ''}>
                ⇩ {f.toUpperCase()}
              </button>
            ))}
            <span className="text-[11px] text-ink-3 ml-2">完整图谱导出（含 DOT、Markdown 档案）：npm run ctos -- export all</span>
          </div>
        </div>

        <WarehousePanel />

        <div className="col-span-12 panel p-4">
          <div className="flex gap-1 mb-3">
            <button className={`btn ${tab === 'todo' ? 'active' : ''}`} onClick={() => setTab('todo')}>研究待办 ({todo.length})</button>
            <button className={`btn ${tab === 'issues' ? 'active' : ''}`} onClick={() => setTab('issues')}>
              数据问题 ({data.meta.issues.errors} 错 / {data.meta.issues.warnings} 警)
            </button>
            <button className={`btn ${tab === 'top' ? 'active' : ''}`} onClick={() => setTab('top')}>影响力榜</button>
          </div>
          {tab === 'todo' && (
            <>
              <div className="text-[11.5px] text-ink-3 mb-2">按“影响力 × 资料缺口”排序。交给 AI 代理：<span className="mono text-ink-2">npm run ctos -- todo</span>，然后按 AGENTS.md 的研究流程补全。</div>
              <div className="grid grid-cols-2 gap-x-6">
                {todo.map(({ e, gaps }) => (
                  <div key={e.id} className="flex items-center gap-2 py-1 border-b border-line/60 cursor-pointer hover:bg-white/5" onClick={() => select(e.id)}>
                    <i className="w-2 h-2 rounded-full shrink-0" style={{ background: entityColor(e) }} />
                    <span className="text-[12.5px] w-28 truncate">{e.name}</span>
                    <span className="mono text-[10px] text-ink-3 w-10">{e.score.toFixed(2)}</span>
                    <span className="text-[11px] text-amber truncate">{gaps.join(' · ')}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === 'issues' && (
            <>
              <div className="flex gap-1 mb-2">
                {(['error', 'warn', 'info'] as const).map((l) => (
                  <button key={l} className={`btn ${level === l ? 'active' : ''}`} onClick={() => setLevel(l)}>{l}</button>
                ))}
              </div>
              <div className="max-h-[50vh] overflow-auto mono text-[11px]">
                {issues.slice(0, 500).map((i, n) => (
                  <div key={n} className="py-0.5 border-b border-line/50">
                    <span className={i.level === 'error' ? 'text-red' : i.level === 'warn' ? 'text-amber' : 'text-ink-3'}>[{i.code}]</span> {i.message}
                    {i.file && <span className="text-ink-3"> ← {i.file}</span>}
                  </div>
                ))}
                {!issues.length && <div className="text-green">无</div>}
              </div>
            </>
          )}
          {tab === 'top' && (
            <div className="grid grid-cols-3 gap-x-6">
              {data.entities
                .slice()
                .sort((a, b) => b.score - a.score)
                .slice(0, 90)
                .map((e, i) => (
                  <div key={e.id} className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-white/5" onClick={() => select(e.id)}>
                    <span className="mono text-[10px] text-ink-3 w-6 text-right">{i + 1}</span>
                    <i className="w-2 h-2 rounded-full" style={{ background: entityColor(e) }} />
                    <span className="text-[12.5px] truncate">{e.name}</span>
                    <span className="mono text-[10px] text-ink-3 ml-auto">{e.score.toFixed(3)}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
