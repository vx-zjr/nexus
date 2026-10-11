/**
 * PROFILER —— 人物/机构档案面板。
 * 展示：身份、履历、按类别分组的关系（含可信度与来源）、所属档案、来源、数据文件路径，
 * 以及“复制 AI 研究指令”按钮：把补全该人物资料的任务直接交给 AI 代理。
 */
import { useMemo, useState } from 'react';
import { CONFIDENCE, ORG_TYPES, RELATION_CATEGORIES, type Relation, type RelationCategory } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { ExternalRecords } from './ExternalRecords';
import { age, countryLabel, entityColor, lifeSpan, roleOf, sectorLabel, span, statusLabel } from '../lib/format';

const CAT_ORDER: RelationCategory[] = ['family', 'political', 'social', 'financial', 'professional', 'legal', 'education', 'org'];

function ConfDot({ c }: { c: keyof typeof CONFIDENCE }) {
  const rank = CONFIDENCE[c].rank;
  const color = rank >= 5 ? '#39ff9f' : rank === 4 ? '#00e5ff' : rank === 3 ? '#ffb000' : '#ff3b4e';
  return (
    <span className="mono text-[9.5px] px-1 border" style={{ color, borderColor: color + '66' }} title={CONFIDENCE[c].desc}>
      {CONFIDENCE[c].zh}
    </span>
  );
}

function aiPrompt(name: string, id: string, files: string[], gaps: string[]) {
  return `请按 AGENTS.md 的“人物研究流程”补全 NEXUS 中的人物「${name}」（id: ${id}）。
现有数据文件：${files.join(', ')}
优先补充：${gaps.join('、') || '核实现有信息并补充最新动态'}。
要求：只用公开合法来源（维基百科、权威媒体、官方网站、监管披露等），每条关系附来源与可信度；
不收录住址、电话、证件号等隐私信息，不收录未成年人；修改写入 data/curated/，完成后运行 npm run ctos -- validate。`;
}

export function ProfilePanel() {
  const { index, selected } = useNexus();
  const select = useNexus((s) => s.select);
  const focus = useNexus((s) => s.focus);
  const openFamily = useNexus((s) => s.openFamily);
  const openPath = useNexus((s) => s.openPath);
  const setScope = useNexus((s) => s.setScope);
  const setView = useNexus((s) => s.setView);
  const starred = useNexus((s) => s.starred);
  const toggleStar = useNexus((s) => s.toggleStar);
  const [showDerived, setShowDerived] = useState(false);
  const [copied, setCopied] = useState('');

  const e = selected ? index?.get(selected) : undefined;
  const groups = useMemo(() => {
    if (!e || !index) return [];
    const rels = index.relationsOf(e.id).filter((r) => showDerived || !r.derived || r.type !== 'alumni');
    const by = new Map<RelationCategory, Relation[]>();
    for (const r of rels) (by.get(r.category) ?? by.set(r.category, []).get(r.category)!).push(r);
    for (const list of by.values())
      list.sort((a, b) => CONFIDENCE[b.confidence].rank - CONFIDENCE[a.confidence].rank || (index.get(index.other(b, e.id))?.score ?? 0) - (index.get(index.other(a, e.id))?.score ?? 0));
    return CAT_ORDER.filter((c) => by.has(c)).map((c) => ({ cat: c, rels: by.get(c)! }));
  }, [e, index, showDerived]);

  if (!e || !index)
    return (
      <div className="h-full flex flex-col items-center justify-center text-ink-3 mono text-[12px] gap-2 p-6 text-center">
        <div className="text-cyan text-3xl">◎</div>
        <div>PROFILER 待命</div>
        <div className="text-[11px]">在网络图中点击节点，或按 <span className="text-ink-2">/</span> 搜索人物</div>
      </div>
    );

  const copy = (text: string, tag: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(''), 1500);
  };
  const rels = index.relationsOf(e.id);
  const gaps = [
    !e.summary && '简介',
    !rels.some((r) => r.category === 'family') && '家族关系',
    e.sources.length + e.links.length < 2 && '可靠来源',
    !e.positions?.length && e.type === 'person' && '履历',
  ].filter(Boolean) as string[];
  // 已故/落马/退休者不显示“现任”；缺结束日期的旧职务只有在世且在任者才视为现任
  const active = !e.died && !e.dissolved && !['deceased', 'purged', 'detained', 'retired', 'exiled'].includes(e.status ?? '');
  const curPositions = active ? (e.positions ?? []).filter((p) => p.current || p.to === null || (!p.to && p.from && Number(p.from.slice(0, 4)) >= new Date().getFullYear() - 12)) : [];
  const pastPositions = (e.positions ?? []).filter((p) => !curPositions.includes(p));
  const a = age(e);

  return (
    <div className="h-full overflow-auto">
      {/* 头部：身份卡 */}
      <div className="p-4 border-b border-line relative" style={{ background: `linear-gradient(135deg, ${entityColor(e)}22, transparent 60%)` }}>
        <div className="hud-title flex justify-between">
          <span>profiler // {e.type === 'person' ? 'person' : 'organization'}</span>
          <span className="flex gap-3">
            <span className={`cursor-pointer ${starred.includes(e.id) ? 'text-amber' : 'hover:text-amber'}`} title="加入/移出关注列表" onClick={() => toggleStar(e.id)}>
              {starred.includes(e.id) ? '★ 已关注' : '☆ 关注'}
            </span>
            <span className="cursor-pointer hover:text-cyan" onClick={() => select(undefined)}>✕</span>
          </span>
        </div>
        <div className="flex items-start gap-3 mt-2">
          <div className="w-14 h-14 shrink-0 flex items-center justify-center text-2xl font-bold border" style={{ borderColor: entityColor(e), color: entityColor(e), borderRadius: e.type === 'person' ? 999 : 2, background: '#05070a' }}>
            {e.name.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="text-[20px] leading-tight font-semibold glow">{e.name}</div>
            {Object.entries(e.names)
              .filter(([, v]) => v !== e.name)
              .map(([k, v]) => (
                <div key={k} className="text-[12px] text-ink-2">{v} <span className="mono text-[10px] text-ink-3">{k}</span></div>
              ))}
            {e.aliases.length > 0 && <div className="text-[11px] text-ink-3 truncate">别名：{e.aliases.slice(0, 6).join('、')}</div>}
            <div className="mono text-[10.5px] text-ink-3 mt-1 cursor-pointer hover:text-cyan" onClick={() => copy(e.id, 'id')} title="复制 id">
              #{e.id} {copied === 'id' && '✓'}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 mt-3">
          {e.country.map((c) => <span key={c} className="chip" style={{ color: entityColor({ ...e, type: 'person', country: [c] }) }}>{countryLabel(c)}</span>)}
          {e.sectors.map((s) => <span key={s} className="chip">{sectorLabel(s)}</span>)}
          {e.orgType && <span className="chip">{ORG_TYPES[e.orgType]}</span>}
          {e.tier && <span className="chip text-amber">T{e.tier}</span>}
          {e.status && e.status !== 'active' && (
            <span className={`chip ${['purged', 'detained', 'investigated'].includes(e.status) ? 'text-red border-red/60' : ''}`}>{statusLabel(e.status)}</span>
          )}
          {lifeSpan(e) && <span className="chip">{lifeSpan(e)}{a && e.type === 'person' ? ` · ${a}岁` : ''}</span>}
          {e.netWorth && <span className="chip text-amber">≈ ${(e.netWorth.usd / 1e9).toFixed(1)}B</span>}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 mono text-[10.5px]">
          <div><div className="text-ink-3">INFLUENCE</div><div className="h-1 bg-line mt-1"><div className="h-full bg-cyan" style={{ width: `${e.score * 100}%` }} /></div></div>
          <div><div className="text-ink-3">LINKS</div><div className="text-ink">{e.degree}</div></div>
          <div><div className="text-ink-3">LAYERS</div><div className="text-ink truncate">{e.layers.join('+')}</div></div>
        </div>
        <div className="flex flex-wrap gap-1 mt-3">
          <button className="btn" onClick={() => focus(e.id, 1)}>◎ 关系网</button>
          {e.type === 'person' && <button className="btn" onClick={() => openFamily('person', e.id)}>⌬ 家族树</button>}
          <button className="btn" onClick={() => openPath(e.id)}>⟷ 路径</button>
          <button className="btn" onClick={() => copy(aiPrompt(e.name, e.id, e.files, gaps), 'ai')}>{copied === 'ai' ? '✓ 已复制' : '✦ AI 研究指令'}</button>
        </div>
      </div>

      {e.summary && <div className="px-4 py-3 border-b border-line text-[12.5px] leading-relaxed text-ink-2 whitespace-pre-wrap">{e.summary.trim()}</div>}
      {e.notes && (
        <details className="px-4 py-2 border-b border-line text-[12px] text-ink-2">
          <summary className="hud-title cursor-pointer">notes · 研究笔记</summary>
          <div className="whitespace-pre-wrap mt-2 leading-relaxed">{e.notes.trim()}</div>
        </details>
      )}

      {(e.positions?.length ?? 0) > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <div className="hud-title mb-2">career · 履历</div>
          {[...curPositions, ...pastPositions].slice(0, 30).map((p, i) => {
            const org = p.org ? index.get(p.org) : undefined;
            const cur = curPositions.includes(p);
            return (
              <div key={i} className="flex gap-2 text-[12px] py-0.5">
                <span className={`mono text-[10.5px] w-24 shrink-0 ${cur ? 'text-green' : 'text-ink-3'}`}>{p.from ?? '?'}–{cur ? '今' : (p.to ?? '?')}</span>
                <span className={cur ? 'text-ink' : 'text-ink-2'}>
                  {p.title}
                  {org && org.name !== p.title && <span className="link ml-1 text-[11px]" onClick={() => select(org.id)}>@{org.name}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {e.dossiers.length > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <div className="hud-title mb-2">dossiers · 所属档案</div>
          <div className="flex flex-wrap gap-1">
            {e.dossiers.map((d) => (
              <button key={d} className="btn" onClick={() => openFamily('dossier', d)}>{index.dossierById.get(d)?.name ?? d}</button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-b border-line">
        <div className="hud-title mb-2 flex justify-between">
          <span>connections · 关系 ({rels.length})</span>
          <label className="normal-case tracking-normal cursor-pointer"><input type="checkbox" checked={showDerived} onChange={(ev) => setShowDerived(ev.target.checked)} /> 含校友</label>
        </div>
        {groups.map(({ cat, rels: list }) => (
          <div key={cat} className="mb-3">
            <div className="text-[11px] mb-1" style={{ color: RELATION_CATEGORIES[cat].color }}>■ {RELATION_CATEGORIES[cat].zh} · {list.length}</div>
            {list.slice(0, 60).map((r) => {
              const o = index.get(index.other(r, e.id));
              if (!o) return null;
              return (
                <div key={r.id} className="group flex items-center gap-2 py-[3px] text-[12px] hover:bg-white/5 px-1 -mx-1">
                  <span className="text-ink-3 w-20 shrink-0 truncate" title={roleOf(r, e.id)}>{roleOf(r, e.id)}</span>
                  <span className="link truncate" onClick={() => select(o.id)}>{o.name}</span>
                  {r.label && <span className="text-[10.5px] text-ink-3 truncate">{r.label}</span>}
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    {span(r) && <span className="mono text-[9.5px] text-ink-3">{span(r)}</span>}
                    <ConfDot c={r.confidence} />
                    {r.sources[0]?.url && (
                      <a href={r.sources[0].url} target="_blank" rel="noreferrer" className="mono text-[10px] text-ink-3 hover:text-cyan" title={r.sources.map((s) => `${s.title ?? s.publisher ?? ''} ${s.url ?? ''}`).join('\n')}>
                        ↗{r.sources.length > 1 ? r.sources.length : ''}
                      </a>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-b border-line">
        <div className="hud-title mb-2">sources · 来源 ({e.sources.length + e.links.length})</div>
        {[...e.links.map((l) => ({ url: l, title: undefined as string | undefined, publisher: undefined as string | undefined, date: undefined as string | undefined })), ...e.sources].slice(0, 24).map((s, i) => (
          <div key={i} className="text-[11.5px] py-0.5 truncate">
            {s.url ? (
              <a className="link" href={s.url} target="_blank" rel="noreferrer">{s.title ?? s.publisher ?? decodeURIComponent(s.url).replace(/^https?:\/\//, '').slice(0, 60)}</a>
            ) : (
              <span className="text-ink-2">{s.title}</span>
            )}
            {s.date && <span className="mono text-[10px] text-ink-3 ml-1">{s.date}</span>}
          </div>
        ))}
      </div>

      <ExternalRecords e={e} />

      <div className="px-4 py-3 mono text-[10.5px] text-ink-3">
        <div className="hud-title mb-1">data files · 数据文件</div>
        {e.files.map((f) => (
          <div key={f} className="cursor-pointer hover:text-cyan" onClick={() => copy(`data/${f}`, f)}>data/{f} {copied === f && '✓'}</div>
        ))}
        {!e.layers.includes('curated') && <div className="mt-1 text-amber">该实体尚未精编：新建 data/curated/{e.type === 'person' ? 'persons' : 'orgs'}/{e.id}.yaml 可覆盖/补充</div>}
        <button className="btn mt-2" onClick={() => { setScope({ kind: 'ego', id: e.id, depth: 2 }); setView('network'); }}>◎◎ 两跳关系网</button>
      </div>
    </div>
  );
}
