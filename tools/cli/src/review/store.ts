/**
 * 身份匹配裁决的持久化：data/curated/_matches/<source>.yaml（精编层的一部分，进 git，可手工编辑；
 * 目录名以 _ 开头，不会被当作实体文件编译）。投影连接器只把 decision: same 的记录接入图谱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readYaml, writeYaml } from '../lib.ts';

export type Decision = 'same' | 'different' | 'unsure';
export const DECISIONS: Decision[] = ['same', 'different', 'unsure'];

export interface MatchDecision {
  /** 图谱实体 id */
  entity: string;
  /** 外部记录 id（ICIJ node_id、FEC 捐款人键、LittleSis id …） */
  ext: string;
  decision: Decision;
  /** 外部记录名称（便于人读） */
  name?: string;
  at?: string;
  by?: string;
  note?: string;
}

export const MATCH_DIR = path.join(DATA_DIR, 'curated', '_matches');
const fileOf = (source: string) => path.join(MATCH_DIR, `${source}.yaml`);
const HEADER = (source: string) =>
  `身份匹配裁决（${source}）：外部记录 ext 是否就是图谱实体 entity。\n` +
  `decision: same=同一人/机构（会被投影进图谱）| different=不同 | unsure=存疑（暂不投影）\n` +
  `由 \`ctos review decide\` 或前端“审核”视图写入，也可手工编辑。`;

export function loadDecisions(source: string): MatchDecision[] {
  const f = fileOf(source);
  if (!fs.existsSync(f)) return [];
  const doc = readYaml(f) as { matches?: MatchDecision[] } | null;
  return (doc?.matches ?? []).map((m) => ({ ...m, ext: String(m.ext) }));
}

export const decisionKey = (entity: string, ext: string) => `${entity}|${ext}`;

export function decisionMap(source: string): Map<string, MatchDecision> {
  return new Map(loadDecisions(source).map((m) => [decisionKey(m.entity, m.ext), m]));
}

/** 写入/覆盖一条裁决（同一 entity+ext 只保留最新） */
export function saveDecision(source: string, d: MatchDecision) {
  if (!/^[a-z0-9-]+$/.test(source)) throw new Error(`非法来源名 ${source}`);
  if (!DECISIONS.includes(d.decision)) throw new Error(`decision 必须是 ${DECISIONS.join('|')}`);
  const list = loadDecisions(source).filter((m) => decisionKey(m.entity, m.ext) !== decisionKey(d.entity, d.ext));
  list.push({ ...d, ext: String(d.ext), at: d.at ?? new Date().toISOString().slice(0, 10) });
  list.sort((a, b) => a.entity.localeCompare(b.entity) || a.ext.localeCompare(b.ext));
  writeYaml(fileOf(source), { matches: list.map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== ''))) }, HEADER(source));
}
