/**
 * 情报时间线：把所有带日期的事实（任免、立案/开除、任命、婚姻、持股、捐款…）汇成按时间倒序的事件流。
 * 只取 tier ≤ 3 的人物的职务变动，避免低层级噪音淹没重要事件。
 */
import { useMemo, useState } from 'react';
import { CONFIDENCE, RELATION_CATEGORIES, relationDef, yearOf, type Entity, type RelationCategory } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { countryLabel, entityColor } from '../lib/format';

interface Ev {
  date: string;
  kind: 'start' | 'end' | 'relation';
  category: RelationCategory | 'career';
  who: Entity;
  other?: Entity;
  text: string;
  confidence?: keyof typeof CONFIDENCE;
  url?: string;
}

const KIND_COLOR: Record<string, string> = { career: '#9aa5b1', ...Object.fromEntries(Object.entries(RELATION_CATEGORIES).map(([k, v]) => [k, v.color])) };

export function TimelineView() {
  const { data, index } = useNexus();
  const select = useNexus((s) => s.select);
  const [country, setCountry] = useState<'all' | 'CN' | 'US'>('all');
  const [cat, setCat] = useState<string>('all');
  const [from, setFrom] = useState(2012);
  const [shown, setShown] = useState(300);
  const [q, setQ] = useState('');

  const events = useMemo(() => {
    if (!data || !index) return [] as Ev[];
    const out: Ev[] = [];
    for (const e of data.entities) {
      if (e.type !== 'person' || (e.tier ?? 5) > 3) continue;
      for (const p of e.positions ?? []) {
        const org = p.org ? index.get(p.org) : undefined;
        const where = org && org.name !== p.title ? ` @${org.name}` : '';
        if (p.from) out.push({ date: p.from, kind: 'start', category: 'career', who: e, other: org, text: `就任 ${p.title}${where}` });
        if (p.to) out.push({ date: p.to, kind: 'end', category: 'career', who: e, other: org, text: `卸任 ${p.title}${where}` });
      }
    }
    for (const r of data.relations) {
      if (r.derived || !r.since) continue;
      const a = index.get(r.from), b = index.get(r.to);
      if (!a || !b) continue;
      const def = relationDef(r.type);
      out.push({
        date: r.since,
        kind: 'relation',
        category: r.category,
        who: a,
        other: b,
        text: `${def.directed ? `→ ${def.out}` : def.out}${r.label ? `：${r.label}` : ''}`,
        confidence: r.confidence,
        url: r.sources[0]?.url,
      });
    }
    return out.sort((x, y) => y.date.localeCompare(x.date));
  }, [data, index]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return events.filter((ev) => {
      if ((yearOf(ev.date) ?? 0) < from) return false;
      if (country !== 'all' && !ev.who.country.includes(country) && !(ev.other?.country.includes(country) ?? false)) return false;
      if (cat !== 'all' && ev.category !== cat) return false;
      if (qq && !ev.who.search.some((k) => k.includes(qq)) && !(ev.other?.search.some((k) => k.includes(qq)) ?? false) && !ev.text.toLowerCase().includes(qq)) return false;
      return true;
    });
  }, [events, country, cat, from, q]);

  let lastYear = '';
  return (
    <div className="h-full w-full grid-bg overflow-auto">
      <div className="max-w-5xl mx-auto p-6">
        <div className="hud-title mb-2">intel timeline · 情报时间线</div>
        <div className="panel brackets p-3 flex flex-wrap items-center gap-2 sticky top-0 z-10">
          {(['all', 'CN', 'US'] as const).map((c) => (
            <button key={c} className={`btn ${country === c ? 'active' : ''}`} onClick={() => setCountry(c)}>{c === 'all' ? '全部' : countryLabel(c)}</button>
          ))}
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">全部类别</option>
            <option value="career">任免</option>
            {Object.entries(RELATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.zh}</option>)}
          </select>
          <span className="hud-title ml-2">自</span>
          <select className="input" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {[1949, 1978, 1990, 2000, 2012, 2017, 2020, 2022, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y} 年</option>)}
          </select>
          <input className="input flex-1 min-w-40" placeholder="过滤人物/事件…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="mono text-[11px] text-ink-3">{filtered.length} 条</span>
        </div>

        <div className="mt-4 relative">
          <div className="absolute left-[92px] top-0 bottom-0 w-px bg-line" />
          {filtered.slice(0, shown).map((ev, i) => {
            const y = ev.date.slice(0, 4);
            const head = y !== lastYear;
            lastYear = y;
            return (
              <div key={i}>
                {head && <div className="mono text-cyan glow text-[13px] mt-4 mb-1 pl-1">{y}</div>}
                <div className="flex items-start gap-3 py-1 group">
                  <span className="mono text-[10.5px] text-ink-3 w-20 text-right shrink-0 pt-0.5">{ev.date}</span>
                  <i className="w-2.5 h-2.5 mt-1 shrink-0 rotate-45 relative z-[1]" style={{ background: ev.kind === 'end' ? 'transparent' : KIND_COLOR[ev.category], border: `1px solid ${KIND_COLOR[ev.category]}` }} />
                  <div className="text-[12.5px] leading-relaxed">
                    <span className="link" style={{ color: entityColor(ev.who) }} onClick={() => select(ev.who.id)}>{ev.who.name}</span>
                    <span className="text-ink-2"> {ev.text} </span>
                    {ev.kind === 'relation' && ev.other && (
                      <span className="link" style={{ color: entityColor(ev.other) }} onClick={() => select(ev.other!.id)}>{ev.other.name}</span>
                    )}
                    {ev.confidence && CONFIDENCE[ev.confidence].rank <= 3 && <span className="mono text-[10px] text-amber ml-2">[{CONFIDENCE[ev.confidence].zh}]</span>}
                    {ev.url && <a className="mono text-[10px] text-ink-3 hover:text-cyan ml-2" href={ev.url} target="_blank" rel="noreferrer">↗</a>}
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length > shown && (
            <button className="btn mt-4 ml-24" onClick={() => setShown((n) => n + 500)}>加载更多（剩余 {filtered.length - shown}）</button>
          )}
        </div>
      </div>
    </div>
  );
}
