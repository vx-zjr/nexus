/**
 * 候选生成：图谱人物/机构 × 外部记录 → 名字分块 → nomenklatura 打分 → 仓库表 review_candidates。
 *
 * 排序分 rank = nk × 国家系数 × 首字母系数 ÷ (1 + log2(歧义度))，中文原名完全一致额外加分；
 * 歧义度 = 外部同键记录数 × 图谱同键实体数。
 * 常见名（同键记录 > maxAmbiguous）只保留国家相符的候选；每个图谱实体最多保留 maxPerEntity 个候选。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { yearOf, type Entity } from '@nexus/core';
import { ROOT, buildGraphData } from '../lib.ts';
import { TMP_DIR, all, lit, openWarehouse } from '../warehouse/db.ts';
import { countryMatch, initialsOf, orgKeys, personKeys, pinyinKeys } from './names.ts';
import { REVIEW_SOURCES, type ExtRecord } from './sources.ts';

const FOCUS = new Set(['CN', 'HK', 'MO', 'TW', 'US']);
const PY = path.join(ROOT, 'tools/py/.venv/bin/python');
const SCORER = path.join(ROOT, 'tools/py/score_pairs.py');

export interface GenOptions {
  maxAmbiguous?: number;
  maxPerEntity?: number;
  /** 只比对人物（默认人物 + 机构） */
  personsOnly?: boolean;
  log: (m: string) => void;
}

interface Pair {
  t: Entity;
  r: ExtRecord;
  key: string;
  cm: number;
  amb: number;
  han: boolean;
  /** 中间名首字母冲突（如 Adam R. Lee vs Adam D. Lee） */
  initialClash: boolean;
  nk?: number;
}

function keysOf(e: Entity): string[] {
  const names = new Set([e.name, ...Object.values(e.names), ...e.aliases].filter(Boolean));
  const out = new Set<string>();
  for (const n of names) {
    if (e.type === 'person') {
      for (const k of personKeys(n)) out.add(`p:${k}`);
      for (const k of pinyinKeys(n)) out.add(`p:${k}`);
    } else for (const k of orgKeys(n)) out.add(`o:${k}`);
  }
  return [...out];
}

/** 调用 Python（nomenklatura logic-v2）批量打分 */
async function score(pairs: Pair[], log: (m: string) => void): Promise<void> {
  if (!fs.existsSync(PY)) {
    log(`  ! 未找到 Python 环境 ${PY}，跳过 nomenklatura 打分（rank 仅用启发式）。安装：python -m venv tools/py/.venv && tools/py/.venv/bin/pip install -r tools/py/requirements.txt`);
    return;
  }
  const t = Date.now();
  const child = spawn(PY, [SCORER], { stdio: ['pipe', 'pipe', 'inherit'] });
  const byId = new Map(pairs.map((p, i) => [String(i), p]));
  let buf = '';
  let done = 0;
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const o = JSON.parse(line) as { id: string; score: number | null };
      const p = byId.get(o.id);
      if (p && o.score !== null) p.nk = o.score;
      if (++done % 20000 === 0) log(`  … 已打分 ${done}/${pairs.length}`);
    }
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`score_pairs.py 退出码 ${code}`))));
  });
  const side = (e: { type?: string; kind?: string; names: string[]; countries: string[]; born?: string | null }) => ({
    schema: (e.type ?? e.kind) === 'person' ? 'Person' : 'LegalEntity',
    names: e.names,
    countries: e.countries.map((c) => c.toLowerCase()),
    born: e.born ?? undefined,
  });
  for (const [i, p] of pairs.entries()) {
    const a = side({ type: p.t.type, names: [p.t.name, ...Object.values(p.t.names)], countries: p.t.country, born: p.t.born });
    const b = side({ kind: p.r.kind, names: [p.r.name], countries: p.r.countries });
    if (!child.stdin.write(JSON.stringify({ id: String(i), a, b }) + '\n')) await new Promise((r) => child.stdin.once('drain', r));
  }
  child.stdin.end();
  await closed;
  log(`  nomenklatura 打分 ${done} 对（${((Date.now() - t) / 1000).toFixed(0)}s）`);
}

export async function generateCandidates(sourceId: string, opts: GenOptions) {
  const { log } = opts;
  const src = REVIEW_SOURCES[sourceId];
  if (!src) throw new Error(`未知审核来源 ${sourceId}（可用：${Object.keys(REVIEW_SOURCES).join(', ')}）`);
  const maxAmb = opts.maxAmbiguous ?? 25;
  const maxPer = opts.maxPerEntity ?? 30;

  log('编译图谱 …');
  const data = buildGraphData({ layout: false, metrics: false });
  const bulk = new Set(data.meta.layers.filter((l) => l.bulk).map((l) => l.id));
  // 比对对象：中美相关、非该来源投影自身生成的实体（如 ICIJ 共同高管、FEC 超级捐款人节点不再与同一来源比对）
  const targets = data.entities.filter(
    (e) =>
      (!opts.personsOnly || e.type === 'person') &&
      !e.layers.every((l) => l === src.id) &&
      e.country.some((c) => FOCUS.has(c)) &&
      (e.layers.some((l) => !bulk.has(l)) || (e.tier ?? 5) <= 4 || e.sectors.includes('family')),
  );
  const tKeys = new Map<string, Entity[]>();
  for (const e of targets) for (const k of keysOf(e)) (tKeys.get(k) ?? tKeys.set(k, []).get(k)!).push(e);
  log(`比对对象 ${targets.length}（人物 ${targets.filter((e) => e.type === 'person').length}），名字键 ${tKeys.size}`);

  const wh = await openWarehouse();
  try {
    log(`读取 ${src.label} …`);
    const recs = await src.records(wh.conn);
    log(`外部记录 ${recs.length}`);
    const hits = new Map<string, ExtRecord[]>();
    for (const r of recs) {
      const ks = r.kind === 'person' ? personKeys(r.name).map((k) => `p:${k}`) : orgKeys(r.name).map((k) => `o:${k}`);
      for (const k of new Set(ks)) if (tKeys.has(k)) (hits.get(k) ?? hits.set(k, []).get(k)!).push(r);
    }
    const pairs = new Map<string, Pair>();
    for (const [k, rs] of hits) {
      const uniq = [...new Map(rs.map((r) => [r.id, r])).values()];
      const ts = tKeys.get(k)!;
      // 歧义度 = 外部同键记录数 × 图谱同键实体数
      const amb = uniq.length * ts.length;
      for (const t of ts) {
        const tInit = new Set([t.name, ...Object.values(t.names), ...t.aliases].flatMap(initialsOf));
        for (const r of uniq) {
          if (t.ids[src.idKey] === r.id) continue; // 已由 Wikidata/精编层对照，无需审核
          // 生卒年与记录年份矛盾（去世后仍在捐款、未满 18 岁）→ 不可能是同一人
          if (r.years) {
            const died = yearOf(t.died ?? undefined), born = yearOf(t.born ?? undefined);
            if ((died && r.years[0] > died) || (born && r.years[0] < born + 18)) continue;
          }
          const cm = countryMatch(t.country, r.countries);
          if (amb > maxAmb && (cm !== 1 || src.capAmbiguity)) continue;
          const han = !!t.names.zh && r.name.replace(/\s/g, '') === t.names.zh;
          const rInit = initialsOf(r.name);
          const initialClash = !!tInit.size && !!rInit.length && !rInit.some((i) => tInit.has(i));
          const id = `${t.id}|${r.id}`;
          const prev = pairs.get(id);
          if (!prev || amb < prev.amb) pairs.set(id, { t, r, key: k, cm, amb, han, initialClash });
        }
      }
    }
    // 每个实体最多保留 maxPer 个（国家相符、低歧义优先）
    const byEntity = new Map<string, Pair[]>();
    for (const p of pairs.values()) (byEntity.get(p.t.id) ?? byEntity.set(p.t.id, []).get(p.t.id)!).push(p);
    const kept: Pair[] = [];
    for (const list of byEntity.values()) kept.push(...list.sort((a, b) => b.cm - a.cm || a.amb - b.amb).slice(0, maxPer));
    log(`候选 ${kept.length}（涉及实体 ${byEntity.size}）`);

    await score(kept, log);

    const now = new Date().toISOString();
    const rows = kept.map((p) => {
      const nk = p.nk ?? 0.7;
      const rank = (nk * (p.cm === 1 ? 1 : p.cm === 0 ? 0.85 : 0.6) * (p.initialClash ? 0.4 : 1)) / (1 + Math.log2(p.amb)) + (p.han ? 0.3 : 0);
      return {
        cand_id: `${src.id}:${p.t.id}:${p.r.id}`,
        source: src.id,
        entity_id: p.t.id,
        entity_name: p.t.name,
        entity_type: p.t.type,
        entity_tier: p.t.tier ?? 5,
        ext_id: p.r.id,
        ext_name: p.r.name,
        ext_kind: p.r.kind,
        ext_countries: p.r.countries,
        ext_dataset: p.r.dataset ?? null,
        ext_detail: p.r.detail ?? null,
        match_key: p.key,
        nk_score: p.nk ?? null,
        country_match: p.cm,
        ambiguity: p.amb,
        han_exact: p.han,
        rank: Math.round(rank * 10000) / 10000,
        created_at: now,
      };
    });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const tmp = path.join(TMP_DIR, `review-${src.id}.jsonl`);
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await wh.conn.run(`CREATE TABLE IF NOT EXISTS review_candidates (
      cand_id VARCHAR PRIMARY KEY, source VARCHAR, entity_id VARCHAR, entity_name VARCHAR, entity_type VARCHAR, entity_tier INTEGER,
      ext_id VARCHAR, ext_name VARCHAR, ext_kind VARCHAR, ext_countries VARCHAR[], ext_dataset VARCHAR, ext_detail VARCHAR,
      match_key VARCHAR, nk_score DOUBLE, country_match INTEGER, ambiguity INTEGER, han_exact BOOLEAN, rank DOUBLE, created_at VARCHAR)`);
    await wh.conn.run(`DELETE FROM review_candidates WHERE source = ${lit(src.id)}`);
    if (rows.length) {
      await wh.conn.run(`INSERT INTO review_candidates SELECT * FROM read_json(${lit(tmp)}, format='newline_delimited', columns={
        cand_id:'VARCHAR', source:'VARCHAR', entity_id:'VARCHAR', entity_name:'VARCHAR', entity_type:'VARCHAR', entity_tier:'INTEGER',
        ext_id:'VARCHAR', ext_name:'VARCHAR', ext_kind:'VARCHAR', ext_countries:'VARCHAR[]', ext_dataset:'VARCHAR', ext_detail:'VARCHAR',
        match_key:'VARCHAR', nk_score:'DOUBLE', country_match:'INTEGER', ambiguity:'INTEGER', han_exact:'BOOLEAN', rank:'DOUBLE', created_at:'VARCHAR'})`);
    }
    fs.rmSync(tmp, { force: true });
    const stat = await all<{ n: number; hi: number }>(wh.conn, `SELECT count(*) n, count(*) FILTER (WHERE rank >= 0.5) hi FROM review_candidates WHERE source = ${lit(src.id)}`);
    log(`已写入 review_candidates：${src.id} ${stat[0].n} 条（rank ≥ 0.5 的高置信候选 ${stat[0].hi} 条）`);
  } finally {
    wh.close();
  }
}
