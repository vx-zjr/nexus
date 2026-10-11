import { CONFIDENCE, COUNTRIES, RELATION_CATEGORIES, SECTORS, type Confidence, type RelationCategory, type Sector } from '@nexus/core';
import { DEFAULT_CATEGORIES, useNexus } from '../store/useNexus';

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5 border-b border-line">
      <div className="hud-title mb-1.5 flex justify-between">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onClick, color, children, count }: { on: boolean; onClick: () => void; color?: string; children: React.ReactNode; count?: number }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 w-full text-left px-1.5 py-[3px] text-[12px] hover:bg-white/5 ${on ? 'text-ink' : 'text-ink-3'}`}>
      <i className="w-2.5 h-2.5 shrink-0 border" style={{ background: on ? (color ?? '#00e5ff') : 'transparent', borderColor: color ?? '#2a3846' }} />
      <span className="truncate">{children}</span>
      {count !== undefined && <span className="ml-auto mono text-[10px] text-ink-3">{count}</span>}
    </button>
  );
}

export function FilterPanel() {
  const { data, filters, scope, starred, index } = useNexus();
  const select = useNexus((s) => s.select);
  const toggleIn = useNexus((s) => s.toggleIn);
  const patch = useNexus((s) => s.patchFilters);
  const setScope = useNexus((s) => s.setScope);
  const setView = useNexus((s) => s.setView);
  if (!data) return null;
  const c = data.meta.counts;
  const countries = Object.entries(c.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const sectors = Object.entries(c.bySector).sort((a, b) => b[1] - a[1]);
  const clear = (k: 'countries' | 'sectors' | 'layers') => patch({ [k]: new Set() } as never);

  return (
    <div className="h-full overflow-auto">
      {starred.length > 0 && (
        <Section title={`★ 关注 · ${starred.length}`}>
          <div className="max-h-48 overflow-auto -mx-1">
            {starred.map((id) => {
              const e = index?.get(id);
              if (!e) return null;
              return (
                <button key={id} className="block w-full text-left px-1.5 py-[3px] text-[12px] text-ink-2 hover:bg-white/5 hover:text-cyan truncate" onClick={() => select(id)}>
                  {e.name} <span className="mono text-[10px] text-ink-3">{e.status && e.status !== 'active' ? e.status : ''}</span>
                </button>
              );
            })}
          </div>
        </Section>
      )}
      <Section title="filter // 实体">
        <div className="flex gap-1">
          {(['person', 'org'] as const).map((t) => (
            <button key={t} className={`btn flex-1 justify-center ${filters.entityTypes.has(t) ? 'active' : ''}`} onClick={() => toggleIn('entityTypes', t)}>
              {t === 'person' ? `人物 ${c.persons}` : `机构 ${c.orgs}`}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 mt-2 text-[12px] text-ink-2 cursor-pointer">
          <input type="checkbox" checked={filters.livingOnly} onChange={(e) => patch({ livingOnly: e.target.checked })} /> 仅在世 / 存续
        </label>
      </Section>

      <Section title="国家/地区" right={filters.countries.size ? <span className="link normal-case" onClick={() => clear('countries')}>全部</span> : undefined}>
        {countries.map(([k, n]) => (
          <Toggle key={k} on={!filters.countries.size || filters.countries.has(k)} color={COUNTRIES[k]?.color} count={n} onClick={() => toggleIn('countries', k)}>
            {COUNTRIES[k]?.zh ?? k}
          </Toggle>
        ))}
      </Section>

      <Section title="领域" right={filters.sectors.size ? <span className="link normal-case" onClick={() => clear('sectors')}>全部</span> : undefined}>
        {sectors.map(([k, n]) => (
          <Toggle key={k} on={!filters.sectors.size || filters.sectors.has(k as Sector)} color={SECTORS[k as Sector]?.color} count={n} onClick={() => toggleIn('sectors', k as Sector)}>
            {SECTORS[k as Sector]?.zh ?? k}
          </Toggle>
        ))}
      </Section>

      <Section
        title="关系类别"
        right={
          <span className="link normal-case" onClick={() => patch({ categories: new Set(DEFAULT_CATEGORIES) })}>
            默认
          </span>
        }
      >
        {(Object.keys(RELATION_CATEGORIES) as RelationCategory[]).map((k) => (
          <Toggle key={k} on={filters.categories.has(k)} color={RELATION_CATEGORIES[k].color} count={c.byCategory[k] ?? 0} onClick={() => toggleIn('categories', k)}>
            {RELATION_CATEGORIES[k].zh}
          </Toggle>
        ))}
        <label className="flex items-center gap-2 mt-1.5 text-[12px] text-ink-2 cursor-pointer">
          <input type="checkbox" checked={filters.showDerived} onChange={(e) => patch({ showDerived: e.target.checked })} /> 显示职务/校友派生边
        </label>
        <div className="mt-2">
          <div className="text-[11px] text-ink-3 mb-1">最低可信度</div>
          <select className="input w-full" value={filters.minConfidence} onChange={(e) => patch({ minConfidence: e.target.value as Confidence })}>
            {Object.entries(CONFIDENCE).reverse().map(([k, v]) => (
              <option key={k} value={k}>≥ {v.zh}（{c.byConfidence[k] ?? 0}）</option>
            ))}
          </select>
        </div>
      </Section>

      <Section title="数据层" right={filters.layers.size ? <span className="link normal-case" onClick={() => clear('layers')}>全部</span> : undefined}>
        {data.meta.layers.map((l) => (
          <Toggle key={l.id} on={!filters.layers.size || filters.layers.has(l.id)} count={l.entityCount} onClick={() => toggleIn('layers', l.id)}>
            {l.name}
          </Toggle>
        ))}
      </Section>

      <Section title={`档案 · ${data.dossiers.length}`}>
        <div className="max-h-64 overflow-auto -mx-1">
          {data.dossiers.slice(0, 120).map((d) => (
            <button
              key={d.id}
              className={`block w-full text-left px-1.5 py-[3px] text-[12px] hover:bg-white/5 ${scope.kind === 'dossier' && scope.id === d.id ? 'text-cyan' : 'text-ink-2'}`}
              onClick={() => {
                setScope({ kind: 'dossier', id: d.id });
                setView('network');
              }}
            >
              {d.name} <span className="mono text-[10px] text-ink-3">{d.members.length}</span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
