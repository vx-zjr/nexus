import { useEffect, useRef, useState } from 'react';
import { useNexus, type View } from '../store/useNexus';
import { EntityPicker } from './EntityPicker';

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'network', label: '关系网络', key: '1' },
  { id: 'family', label: '家族档案', key: '2' },
  { id: 'path', label: '关系路径', key: '3' },
  { id: 'timeline', label: '时间线', key: '4' },
  { id: 'data', label: '数据中心', key: '5' },
  { id: 'review', label: '审核', key: '6' },
];

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return <span className="mono text-[11px] text-ink-3">{t.toISOString().replace('T', ' ').slice(0, 19)}Z</span>;
}

export function TopBar() {
  const { data, view, showLeft, showRight, online } = useNexus();
  const setView = useNexus((s) => s.setView);
  const select = useNexus((s) => s.select);
  const togglePanel = useNexus((s) => s.togglePanel);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') select(undefined);
      else {
        const v = VIEWS.find((x) => x.key === e.key);
        if (v) setView(v.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select, setView]);

  const c = data?.meta.counts;
  return (
    <div className="h-12 shrink-0 flex items-center gap-4 px-3 border-b border-line bg-panel/90 relative z-20">
      <button className="btn px-2" onClick={() => togglePanel('left')} title="筛选面板">{showLeft ? '◧' : '▤'}</button>
      <div className="flex items-baseline gap-2 select-none">
        <span className="mono font-bold tracking-[0.3em] text-cyan glow text-[15px]">NEXUS</span>
        <span className="mono text-[10px] text-ink-3 tracking-[0.2em] whitespace-nowrap hidden xl:inline">// 人脉情报中心</span>
      </div>
      <div className="flex gap-1 ml-2">
        {VIEWS.map((v) => (
          <button key={v.id} className={`btn ${view === v.id ? 'active' : ''}`} onClick={() => setView(v.id)} title={`快捷键 ${v.key}`}>
            {v.label}
          </button>
        ))}
      </div>
      <EntityPicker
        inputRef={searchRef}
        placeholder="搜索 人名/拼音/英文/机构…  [ / ]"
        className="w-80 min-w-40 shrink"
        wide
        onPick={(id) => {
          select(id);
          if (['data', 'path', 'timeline', 'review'].includes(useNexus.getState().view)) setView('network');
        }}
      />
      <div className="ml-auto flex items-center gap-4">
        {c && (
          <div className="mono text-[11px] text-ink-2 gap-3 hidden lg:flex">
            <span title={`浏览器已加载 ${data.entities.length.toLocaleString()} 个实体（核心子图 + 按需加载）`}>
              <span className="text-ink-3">ENT</span> {c.entities.toLocaleString()}
              {data.meta.subset && <span className="text-ink-3"> / {data.entities.length.toLocaleString()} 已载</span>}
            </span>
            <span><span className="text-ink-3">REL</span> {c.relations.toLocaleString()}</span>
            <span><span className="text-ink-3">SRC</span> {c.sources.toLocaleString()}</span>
            {data.meta.issues.errors > 0 && <span className="text-red">ERR {data.meta.issues.errors}</span>}
          </div>
        )}
        <span className="hidden xl:inline"><Clock /></span>
        {online ? (
          <span className="w-2 h-2 rounded-full bg-green shadow-[0_0_8px_#39ff9f]" title="本地 API 在线：完整图谱按需加载、原始仓库检索、审核" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-amber shadow-[0_0_8px_#ffb000]" title="静态模式：只有 graph.json 中的核心子图（运行 npm run ctos -- serve 启用完整功能）" />
        )}
        <button className="btn px-2" onClick={() => togglePanel('right')} title="档案面板">{showRight ? '◨' : '▤'}</button>
      </div>
    </div>
  );
}
