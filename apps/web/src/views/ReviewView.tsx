/**
 * 审核视图（MATCH REVIEW）：外部记录（ICIJ 离岸解密等）与图谱人物/机构的身份匹配候选，逐条裁决。
 * 候选由 `ctos review gen <source>` 生成（名字分块 + nomenklatura 打分），裁决写入 data/curated/_matches/<source>.yaml，
 * “投影进图谱”会运行对应连接器，只把 decision: same 的匹配接入图谱。
 *
 * 同名 ≠ 同一人：请结合国家、出生年份、公司所在地、同一公司的其他高管（常为亲属）等线索判断；拿不准选“存疑”。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../store/useNexus';
import { reviewApply, reviewDecide, reviewList, reviewStats, type ReviewCandidate, type ReviewStat } from '../lib/api';

const STATUS = [
  ['pending', '待审'],
  ['same', '同一'],
  ['different', '不同'],
  ['unsure', '存疑'],
  ['all', '全部'],
] as const;
const PAGE = 30;

/** 审核上下文中关联对象的原始页面 */
function contextUrl(source: string, id: string) {
  if (source === 'fec') return `https://www.fec.gov/data/committee/${id}/`;
  if (source === 'littlesis') return `https://littlesis.org/entities/${id}`;
  return `https://offshoreleaks.icij.org/nodes/${id}`;
}

export function ReviewView() {
  const online = useNexus((s) => s.online);
  const select = useNexus((s) => s.select);
  const reviewEntity = useNexus((s) => s.reviewEntity);
  const [stats, setStats] = useState<ReviewStat[]>([]);
  const [source, setSource] = useState('icij');
  const [status, setStatus] = useState<string>('pending');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; items: ReviewCandidate[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [applyLog, setApplyLog] = useState<string[] | null>(null);

  const refreshStats = useCallback(() => {
    reviewStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (online) refreshStats();
  }, [online, refreshStats]);

  useEffect(() => {
    if (!online) return;
    setBusy(true);
    setErr('');
    reviewList({ source, status, q: q.trim() || undefined, entity: reviewEntity, offset, limit: PAGE })
      .then(setData)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [online, source, status, q, offset, reviewEntity]);

  const decide = async (c: ReviewCandidate, decision: 'same' | 'different' | 'unsure') => {
    try {
      await reviewDecide({ source: c.source, entity: c.entity_id, ext: c.ext_id, decision, name: c.ext_name });
      // 乐观更新：待审列表中移除，其他列表中更新状态
      setData((d) =>
        d && {
          total: status === 'pending' ? d.total - 1 : d.total,
          items: status === 'pending' ? d.items.filter((x) => x.cand_id !== c.cand_id) : d.items.map((x) => (x.cand_id === c.cand_id ? { ...x, decision: { decision } } : x)),
        },
      );
      refreshStats();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!online) {
    return (
      <div className="h-full grid-bg flex items-center justify-center">
        <div className="panel brackets p-6 max-w-lg mono text-[12px] text-ink-2">
          <div className="hud-title text-amber mb-2">offline</div>
          审核需要本地 API：运行 <span className="text-cyan">npm run dev</span>（会自动启动）或 <span className="text-cyan">npm run ctos -- serve</span>。
        </div>
      </div>
    );
  }

  const st = stats.find((s) => s.source === source);
  // 按实体分组（服务端已按实体排序）
  const groups: { id: string; name: string; tier: number; items: ReviewCandidate[] }[] = [];
  for (const c of data?.items ?? []) {
    const g = groups.at(-1);
    if (g && g.id === c.entity_id) g.items.push(c);
    else groups.push({ id: c.entity_id, name: c.entity_name, tier: c.entity_tier, items: [c] });
  }

  return (
    <div className="h-full w-full grid-bg overflow-auto">
      <div className="max-w-6xl mx-auto p-6">
        <div className="hud-title mb-2">match review · 身份匹配审核</div>
        <div className="panel brackets p-4 flex flex-wrap items-center gap-3">
          {(stats.length ? stats : [{ source: 'icij', label: 'ICIJ' } as ReviewStat]).map((s) => (
            <button key={s.source} className={`btn ${source === s.source ? 'active' : ''}`} onClick={() => { setSource(s.source); setOffset(0); }}>
              {s.label}
            </button>
          ))}
          {st && (
            <div className="mono text-[11px] text-ink-2 flex gap-3">
              <span>候选 {st.total.toLocaleString()}（{st.entities.toLocaleString()} 个实体）</span>
              <span className="text-amber">待审 {st.pending.toLocaleString()}（高置信 {st.pendingHigh.toLocaleString()}）</span>
              <span className="text-green">同一 {st.same}</span>
              <span>不同 {st.different}</span>
              <span>存疑 {st.unsure}</span>
            </div>
          )}
          <button
            className="btn ml-auto"
            disabled={!st?.same}
            title="运行投影连接器：把“同一”的匹配及其关联写入图谱层"
            onClick={() => {
              setApplyLog(['运行中…']);
              reviewApply(source)
                .then((r) => setApplyLog(r.log))
                .catch((e: Error) => setApplyLog([`失败：${e.message}`]));
            }}
          >
            ⇪ 投影进图谱
          </button>
          <div className="w-full flex flex-wrap items-center gap-1">
            {STATUS.map(([k, label]) => (
              <button key={k} className={`btn ${status === k ? 'active' : ''}`} onClick={() => { setStatus(k); setOffset(0); }}>
                {label}
              </button>
            ))}
            <input className="input w-56 ml-2" placeholder="按名字/实体 id 过滤…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
            {reviewEntity && (
              <button className="btn text-amber" onClick={() => useNexus.setState({ reviewEntity: undefined })}>
                仅 {reviewEntity} ✕
              </button>
            )}
            <span className="ml-auto mono text-[11px] text-ink-3">
              {data ? `${Math.min(offset + 1, data.total)}–${Math.min(offset + PAGE, data.total)} / ${data.total.toLocaleString()}` : ''}
            </span>
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>◂</button>
            <button className="btn" disabled={!data || offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>▸</button>
          </div>
        </div>

        {applyLog && (
          <div className="panel mt-3 p-3 mono text-[11px] text-ink-2 whitespace-pre-wrap">
            {applyLog.join('\n')}
            <button className="btn ml-2" onClick={() => setApplyLog(null)}>✕</button>
          </div>
        )}
        {err && <div className="mt-4 mono text-red">{err}</div>}
        {busy && <div className="mt-4 mono text-cyan caret">LOADING CANDIDATES</div>}
        {data && !data.total && !busy && (
          <div className="mt-6 mono text-ink-3 text-[12px]">没有候选。生成候选：<span className="text-cyan">npm run ctos -- review gen {source}</span></div>
        )}

        {groups.map((g) => (
          <div key={g.id} className="mt-4 panel p-3 flex gap-4">
            <div className="w-48 shrink-0">
              <div className="link text-[14px]" onClick={() => select(g.id)}>{g.name}</div>
              <div className="mono text-[10px] text-ink-3">#{g.id} · T{g.tier}</div>
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              {g.items.map((c) => (
                <div key={c.cand_id} className="border border-line-2 bg-panel-2 p-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="mono text-[11px] w-12 shrink-0" style={{ color: c.rank >= 0.8 ? '#39ff9f' : c.rank >= 0.5 ? '#00e5ff' : c.rank >= 0.3 ? '#ffb000' : '#7b8794' }} title="综合排序分">
                      {c.rank.toFixed(2)}
                    </span>
                    <a className="link text-[13px]" href={c.url} target="_blank" rel="noreferrer">{c.ext_name}</a>
                    <span className="chip">{c.ext_kind === 'person' ? '人' : '机构'}</span>
                    {c.ext_countries.map((x) => <span key={x} className="chip">{x}</span>)}
                    {c.han_exact && <span className="chip text-green">中文名一致</span>}
                    {c.country_match === -1 && <span className="chip text-amber">国家不符</span>}
                    <span className="mono text-[10px] text-ink-3">nk={c.nk_score ?? '-'} · 歧义 {c.ambiguity} · {c.ext_dataset}{c.source !== 'icij' && c.ext_detail ? ` · ${c.ext_detail}` : ''}</span>
                    <span className="ml-auto flex gap-1">
                      {c.decision && <span className="chip text-cyan">{STATUS.find(([k]) => k === c.decision!.decision)?.[1]}</span>}
                      <button className="btn text-green" onClick={() => void decide(c, 'same')}>✓ 同一</button>
                      <button className="btn" onClick={() => void decide(c, 'different')}>✗ 不同</button>
                      <button className="btn text-amber" onClick={() => void decide(c, 'unsure')}>? 存疑</button>
                    </span>
                  </div>
                  {(c.context?.length ?? 0) > 0 && (
                    <div className="mt-1 pl-14">
                      {c.context!.slice(0, 8).map((x, i) => (
                        <div key={i} className="text-[11.5px] text-ink-2 truncate">
                          <span className="text-ink-3">{x.dir === 'out' ? '→' : '←'} {x.link}：</span>
                          <a className="link" href={contextUrl(c.source, x.id)} target="_blank" rel="noreferrer">{x.name}</a>
                          <span className="text-[10px] text-ink-3"> {x.detail ?? ''} · {x.dataset ?? ''}</span>
                        </div>
                      ))}
                      {c.context!.length > 8 && <div className="text-[10px] text-ink-3">… 另 {c.context!.length - 8} 条</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-6 text-[11px] text-ink-3 leading-6">
          判断要点：同名不等于同一人。看国家/地区是否相符、出生年份（若有）、离岸公司注册时间是否与其任职经历吻合、同一公司的其他股东/董事是否为其亲属。
          证据不足时选“存疑”。裁决写入 <span className="mono">data/curated/_matches/{source}.yaml</span>（进 git，可手工修改）。
        </div>
      </div>
    </div>
  );
}
