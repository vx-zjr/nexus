import {
  CONFIDENCE,
  COUNTRIES,
  PERSON_STATUS,
  SECTORS,
  countryColor,
  yearOf,
  type Entity,
  type Relation,
  relationDef,
} from '@nexus/core';

export function lifeSpan(e: Entity): string {
  if (e.type === 'org') return e.founded ? `${e.founded}${e.dissolved ? '–' + e.dissolved : ''}` : '';
  if (!e.born && !e.died) return '';
  return `${e.born ?? '?'}–${e.died ?? ''}`;
}

export function age(e: Entity): number | undefined {
  const b = yearOf(e.born);
  if (!b) return undefined;
  const end = yearOf(e.died) ?? new Date().getFullYear();
  return end - b;
}

export function countryLabel(c: string) {
  return COUNTRIES[c]?.zh ?? c;
}

export function sectorLabel(s: string) {
  return (SECTORS as Record<string, { zh: string }>)[s]?.zh ?? s;
}

export function statusLabel(s?: string) {
  return s ? ((PERSON_STATUS as Record<string, string>)[s] ?? s) : '';
}

const COMMUNITY_PALETTE = ['#00e5ff', '#ff4d5e', '#ffd166', '#6fcf97', '#c792ea', '#ff8a3d', '#3b9cff', '#f78fb3', '#7fd1b9', '#a3e635', '#fca5a5', '#9b8cff'];

export function nodeColor(e: Entity, mode: 'country' | 'sector' | 'community'): string {
  if (mode === 'sector') return (SECTORS as Record<string, { color: string }>)[e.sectors[0]]?.color ?? '#7b8794';
  if (mode === 'community') return e.community === undefined ? '#5c6b7a' : COMMUNITY_PALETTE[e.community % COMMUNITY_PALETTE.length];
  return entityColor(e);
}

export function entityColor(e: Entity): string {
  if (e.type === 'org') return (SECTORS as Record<string, { color: string }>)[e.sectors[0]]?.color ?? '#7b8794';
  return countryColor(e.country[0]);
}

/** 从 who 的视角描述关系：返回“对方是我的什么” */
export function roleOf(r: Relation, who: string): string {
  const def = relationDef(r.type);
  return r.from === who ? def.out : def.in;
}

export function confLabel(c: keyof typeof CONFIDENCE) {
  return CONFIDENCE[c].zh;
}

export function span(r: { since?: string | null; until?: string | null; current?: boolean }) {
  if (!r.since && !r.until) return '';
  return `${r.since ?? '?'}–${r.until ?? (r.current ? '今' : '')}`;
}

export function shortSummary(e: Entity, n = 60): string {
  const cur = e.positions?.find((p) => p.current || p.to === null || p.to === undefined);
  const s = (e.summary ?? '').split('\n')[0].trim();
  const t = s || cur?.title || '';
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function displayName(e: Entity): string {
  return e.name;
}

export function altName(e: Entity): string | undefined {
  const alt = e.names.zh && e.names.zh !== e.name ? e.names.zh : e.names.en && e.names.en !== e.name ? e.names.en : undefined;
  return alt;
}
