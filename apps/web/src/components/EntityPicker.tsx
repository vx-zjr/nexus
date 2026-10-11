import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entity } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { remoteSearch } from '../lib/api';
import { countryLabel, entityColor, lifeSpan, shortSummary } from '../lib/format';

interface Props {
  placeholder?: string;
  onPick: (id: string) => void;
  value?: string;
  className?: string;
  wide?: boolean;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/** 实体搜索选择器：中文 / 英文 / 拼音 / 拼音首字母 / 别名 / id */
export function EntityPicker({ placeholder = '搜索…', onPick, value, className = '', wide, autoFocus, inputRef }: Props) {
  const index = useNexus((s) => s.index);
  const online = useNexus((s) => s.online);
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Entity[]>([]);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  // 在线时同时检索完整图谱（含未加载的 bulk 层），去重后排在本地结果之后
  useEffect(() => {
    setRemote([]);
    if (!online || !q.trim()) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      remoteSearch(q, 12, ac.signal).then(setRemote).catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, online]);
  const results: Entity[] = useMemo(() => {
    const local = index && q.trim() ? index.search(q, 12) : [];
    const seen = new Set(local.map((e) => e.id));
    return [...local, ...remote.filter((e) => !seen.has(e.id))].slice(0, 16);
  }, [index, q, remote]);
  useEffect(() => setCur(0), [q]);
  const picked = value ? index?.get(value) : undefined;

  const pick = (e: Entity) => {
    // 远程结果先并入本地图（其关系由 useRemoteSync 随后补齐）
    if (!index?.get(e.id)) useNexus.getState().mergePatch({ entities: [e], relations: [] });
    onPick(e.id);
    setQ('');
    setOpen(false);
    ref.current?.blur();
  };

  return (
    <div className={`relative ${className}`}>
      <input
        ref={ref}
        autoFocus={autoFocus}
        className={`input ${wide ? 'w-full' : 'w-52'}`}
        placeholder={picked ? `${picked.name}  (${picked.id})` : placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCur((c) => Math.min(c + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setCur((c) => Math.max(c - 1, 0));
          else if (e.key === 'Enter' && results[cur]) pick(results[cur]);
          else if (e.key === 'Escape') {
            setOpen(false);
            ref.current?.blur();
          }
        }}
      />
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-[380px] max-h-[60vh] overflow-auto panel brackets shadow-2xl shadow-black">
          {results.map((e, i) => (
            <div
              key={e.id}
              onMouseDown={(ev) => {
                ev.preventDefault();
                pick(e);
              }}
              onMouseEnter={() => setCur(i)}
              className={`px-3 py-1.5 cursor-pointer border-l-2 ${i === cur ? 'bg-cyan/10 border-cyan' : 'border-transparent'}`}
            >
              <div className="flex items-baseline gap-2">
                <i className="inline-block w-2 h-2 shrink-0" style={{ background: entityColor(e), borderRadius: e.type === 'person' ? 99 : 0 }} />
                <span className="text-[13px] text-ink">{e.name}</span>
                {e.names.en && e.names.en !== e.name && <span className="text-[11px] text-ink-3 truncate">{e.names.en}</span>}
                {!index?.get(e.id) && <span className="mono text-[9px] text-amber shrink-0" title="来自完整图谱（尚未加载）">EXT</span>}
                <span className="ml-auto mono text-[10px] text-ink-3 shrink-0">{lifeSpan(e)}</span>
              </div>
              <div className="mono text-[10px] text-ink-3 truncate pl-4">
                {e.country.map(countryLabel).join('/')} · {shortSummary(e, 40) || e.id}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
