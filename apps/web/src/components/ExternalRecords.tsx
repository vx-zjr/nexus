/**
 * 档案面板中的“外部记录”：外部 ID 直达链接 + 在原始数据仓库中检索同名记录 + 该实体的待审匹配候选。
 * 仓库检索与审核需要本地 API（ctos serve）。
 */
import { useEffect, useState } from 'react';
import type { Entity } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { reviewList, warehouseSearch, type WarehouseHit } from '../lib/api';

/** 外部 ID → 网页链接（格式来自 Wikidata 各属性的 formatter URL） */
const ID_LINKS: Record<string, (v: string, e: Entity) => string> = {
  wikidata: (v) => `https://www.wikidata.org/wiki/${v}`,
  opensanctions: (v) => `https://www.opensanctions.org/entities/${v}/`,
  bioguide: (v) => `https://bioguide.congress.gov/search/bio/${v}`,
  fec: (v) => `https://www.fec.gov/data/candidate/${v}/`,
  fec_committee: (v) => `https://www.fec.gov/data/committee/${v}/`,
  opensecrets: (v, e) => (e.type === 'org' ? `https://www.opensecrets.org/orgs/summary?id=${v}` : `https://www.opensecrets.org/members-of-congress/summary?cid=${v}`),
  govtrack: (v) => `https://www.govtrack.us/congress/members/${v}`,
  fjc: (v) => `https://www.fjc.gov/node/${v}`,
  icij: (v) => `https://offshoreleaks.icij.org/nodes/${v}`,
  littlesis: (v, e) => `https://littlesis.org/${e.type === 'org' ? 'org' : 'person'}/${v}`,
  cped: (v) => `https://cped.nccu.edu.tw/eliteDetail.aspx?pid=${v}`,
};

/** 仓库检索结果 → 网页链接 */
function hitUrl(h: WarehouseHit): string | undefined {
  switch (h.source) {
    case 'opensanctions':
      return `https://www.opensanctions.org/entities/${h.id}/`;
    case 'icij':
      return `https://offshoreleaks.icij.org/nodes/${h.id}`;
    case 'congress':
      return `https://bioguide.congress.gov/search/bio/${h.id}`;
    case 'fjc':
      return `https://www.fjc.gov/node/${h.id}`;
    case 'fec':
      return h.kind === 'candidate' ? `https://www.fec.gov/data/candidate/${h.id}/` : `https://www.fec.gov/data/committee/${h.id}/`;
    case 'littlesis':
      return `https://littlesis.org/${h.kind === 'org' ? 'org' : 'person'}/${h.id}`;
  }
  return undefined;
}

export function ExternalRecords({ e }: { e: Entity }) {
  const online = useNexus((s) => s.online);
  const setView = useNexus((s) => s.setView);
  const [hits, setHits] = useState<WarehouseHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<number | null>(null);
  const q = e.names.en ?? e.name;

  useEffect(() => {
    setHits(null);
    setErr('');
    setPending(null);
    if (!online) return;
    // 各审核来源中该实体的待审候选数
    Promise.all(['icij', 'fec', 'littlesis'].map((source) => reviewList({ source, status: 'pending', entity: e.id, limit: 1 }).then((r) => r.total).catch(() => 0)))
      .then((ns) => setPending(ns.reduce((a, b) => a + b, 0)))
      .catch(() => setPending(null));
  }, [e.id, online]);

  const search = () => {
    setBusy(true);
    setErr('');
    warehouseSearch(q, undefined, 12)
      .then(setHits)
      .catch((x: Error) => setErr(x.message))
      .finally(() => setBusy(false));
  };

  const ids = Object.entries(e.ids);
  if (!ids.length && !online) return null;
  return (
    <div className="px-4 py-3 border-b border-line">
      <div className="hud-title mb-2">external records · 外部记录</div>
      {ids.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 mono text-[10.5px] mb-2">
          {ids.map(([k, v]) =>
            ID_LINKS[k] ? (
              <a key={k} className="link" href={ID_LINKS[k](v, e)} target="_blank" rel="noreferrer">{k}:{v}</a>
            ) : (
              <span key={k} className="text-ink-3">{k}:{v}</span>
            ),
          )}
        </div>
      )}
      {online && (
        <>
          <div className="flex flex-wrap gap-1 items-center">
            <button className="btn" disabled={busy} onClick={search}>{busy ? '检索中…' : `⌕ 在原始仓库检索 “${q}”`}</button>
            {pending !== null && pending > 0 && (
              <button
                className="btn text-amber"
                onClick={() => {
                  useNexus.setState({ reviewEntity: e.id });
                  setView('review');
                }}
              >
                ⚑ {pending} 条外部记录待审
              </button>
            )}
          </div>
          {err && <div className="mono text-[11px] text-red mt-1">{err}</div>}
          {hits && (
            <div className="mt-2">
              {!hits.length && <div className="mono text-[11px] text-ink-3">无同名记录</div>}
              {hits.slice(0, 40).map((h, i) => {
                const url = hitUrl(h);
                return (
                  <div key={i} className="text-[11.5px] py-[2px] flex gap-2">
                    <span className="mono text-[10px] text-ink-3 w-20 shrink-0 truncate">{h.source}/{h.kind}</span>
                    {url ? <a className="link truncate" href={url} target="_blank" rel="noreferrer">{h.name}</a> : <span className="truncate">{h.name}</span>}
                    <span className="text-[10px] text-ink-3 truncate">{h.detail}</span>
                  </div>
                );
              })}
              <div className="mono text-[10px] text-ink-3 mt-1">同名不等于同一人：确认后在“审核”视图或精编层中建立关联</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
