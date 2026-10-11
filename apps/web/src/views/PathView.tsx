/**
 * 关系路径（“六度分隔”）：两人之间经由哪些人/机构相连。
 * 边权来自关系词表（家族最近、校友最远），并惩罚经过超级枢纽机构的路径。
 */
import { useEffect, useMemo, useState } from 'react';
import { CONFIDENCE, RELATION_CATEGORIES, type RelationCategory, type PathStep } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { EntityPicker } from '../components/EntityPicker';
import { remotePaths } from '../lib/api';
import { entityColor, lifeSpan, roleOf, shortSummary, span } from '../lib/format';

const CATS = Object.keys(RELATION_CATEGORIES) as RelationCategory[];

export function PathView() {
  const { index, pathA, pathB, online } = useNexus();
  const select = useNexus((s) => s.select);
  const setScope = useNexus((s) => s.setScope);
  const setView = useNexus((s) => s.setView);
  const [k, setK] = useState(4);
  const [cats, setCats] = useState<Set<RelationCategory>>(new Set(CATS.filter((c) => c !== 'education')));
  const [minConf, setMinConf] = useState<keyof typeof CONFIDENCE>('rumor');

  // 在线：在完整图谱上由服务端计算（可经过尚未加载的实体）；离线：在已加载的子图上本地计算
  const fkey = `${pathA}|${pathB}|${k}|${[...cats].sort().join(',')}|${minConf}`;
  const [remote, setRemote] = useState<{ key: string; paths: { id: string; via?: string }[][] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!online || !pathA || !pathB || pathA === pathB) return;
    setBusy(true);
    setErr('');
    remotePaths(pathA, pathB, k, { categories: cats, minConfidence: minConf })
      .then((p) => setRemote({ key: fkey, paths: p }))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fkey, online]);

  const paths: PathStep[][] = useMemo(() => {
    if (!index || !pathA || !pathB || pathA === pathB) return [];
    if (online) {
      if (!remote || remote.key !== fkey) return [];
      return remote.paths
        .map((p) => p.map((s) => ({ id: s.id, via: s.via ? index.relById.get(s.via) : undefined })))
        .filter((p) => p.every((s, i) => index.get(s.id) && (i === 0 || s.via)));
    }
    return index.paths(pathA, pathB, k, { categories: cats, minConfidence: minConf });
  }, [index, pathA, pathB, k, cats, minConf, online, remote, fkey]);

  const showOnGraph = (p: PathStep[]) => {
    setScope({ kind: 'path', ids: p.map((s) => s.id), relIds: p.filter((s) => s.via).map((s) => s.via!.id) });
    setView('network');
  };

  return (
    <div className="h-full w-full grid-bg overflow-auto">
      <div className="max-w-5xl mx-auto p-6">
        <div className="hud-title mb-2">link analysis · 关系路径</div>
        <div className="panel brackets p-4 flex flex-wrap items-center gap-3">
          <EntityPicker placeholder="起点人物…" value={pathA} onPick={(id) => useNexus.setState({ pathA: id })} />
          <span className="mono text-cyan">⟷</span>
          <EntityPicker placeholder="终点人物…" value={pathB} onPick={(id) => useNexus.setState({ pathB: id })} />
          <button className="btn" onClick={() => useNexus.setState({ pathA: pathB, pathB: pathA })}>⇄ 交换</button>
          <div className="flex items-center gap-1 ml-auto">
            <span className="hud-title">路径数</span>
            {[1, 3, 5].map((n) => (
              <button key={n} className={`btn ${k === n ? 'active' : ''}`} onClick={() => setK(n)}>{n}</button>
            ))}
          </div>
          <div className="w-full flex flex-wrap gap-1 items-center">
            <span className="hud-title mr-1">允许经过</span>
            {CATS.map((c) => (
              <button
                key={c}
                className={`btn ${cats.has(c) ? 'active' : ''}`}
                onClick={() => setCats((s) => {
                  const n = new Set(s);
                  if (n.has(c)) n.delete(c);
                  else n.add(c);
                  return n;
                })}
              >
                {RELATION_CATEGORIES[c].zh}
              </button>
            ))}
            <span className="hud-title ml-3 mr-1">最低可信度</span>
            <select className="input" value={minConf} onChange={(e) => setMinConf(e.target.value as keyof typeof CONFIDENCE)}>
              {Object.entries(CONFIDENCE).map(([key, v]) => (
                <option key={key} value={key}>{v.zh}</option>
              ))}
            </select>
          </div>
        </div>

        {busy && <div className="mt-6 mono text-cyan caret">TRACING LINKS（完整图谱）</div>}
        {err && <div className="mt-6 mono text-red">{err}</div>}
        {pathA && pathB && !busy && !err && !paths.length && <div className="mt-6 mono text-ink-3">没有找到满足条件的路径。试试放宽“允许经过”的关系类别。</div>}

        {paths.map((p, pi) => (
          <div key={pi} className="mt-5 panel p-4">
            <div className="flex items-center mb-3">
              <span className="mono text-cyan glow">PATH #{pi + 1}</span>
              <span className="mono text-ink-3 ml-3">{p.length - 1} 跳</span>
              <button className="btn ml-auto" onClick={() => showOnGraph(p)}>⇢ 在网络图中显示</button>
            </div>
            <div className="flex flex-wrap items-stretch gap-y-3">
              {p.map((s, i) => {
                const e = index!.get(s.id)!;
                const prevId = i > 0 ? p[i - 1].id : undefined;
                return (
                  <div key={s.id + i} className="flex items-center">
                    {s.via && prevId && (
                      <div className="flex flex-col items-center px-2 min-w-28">
                        <div className="mono text-[11px] text-cyan text-center">
                          {s.via.label ? `${s.via.label}` : roleOf(s.via, prevId)}
                        </div>
                        <div className="w-full h-px my-1" style={{ background: RELATION_CATEGORIES[s.via.category].color, opacity: 0.4 + CONFIDENCE[s.via.confidence].rank * 0.1 }} />
                        <div className="mono text-[10px] text-ink-3">
                          {RELATION_CATEGORIES[s.via.category].zh} · {CONFIDENCE[s.via.confidence].zh} {span(s.via)}
                        </div>
                        {s.via.sources[0]?.url && (
                          <a className="mono text-[10px] link" href={s.via.sources[0].url} target="_blank" rel="noreferrer">
                            来源 ↗
                          </a>
                        )}
                      </div>
                    )}
                    <div onClick={() => select(e.id)} className="cursor-pointer border border-line-2 hover:border-cyan bg-panel-2 px-3 py-2 w-44" style={{ borderLeft: `3px solid ${entityColor(e)}` }}>
                      <div className="text-[13px]">{e.name}</div>
                      <div className="mono text-[10px] text-ink-3">{lifeSpan(e)}</div>
                      <div className="text-[11px] text-ink-2 truncate">{shortSummary(e, 30)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {!pathA && (
          <div className="mt-6 text-ink-3 text-[12px] leading-6">
            示例：选两个看似无关的人 —— 比如一位美国内阁成员和一位中国政治局委员 —— 系统会找出他们之间最短的已知关系链，
            并标出每一跳的关系类型、时间、可信度与来源。
          </div>
        )}
      </div>
    </div>
  );
}
