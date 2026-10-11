/**
 * 编译器：把多个数据层（curated / imports/*）中的原始文件合并为一张规范化的关系图。
 *
 *   原始文件(RawDoc[]) ──解析/校验──▶ 片段 ──身份合并(id + 外部ID)──▶ 实体
 *                                            └─关系归一/去重/派生──▶ 关系
 *                                            └─隐私与未成年人策略──▶ 过滤
 *                                            └─度数/PageRank/社区──▶ GraphData
 *
 * 纯函数，不读写文件系统：Node CLI、Vite 插件、浏览器、测试均可调用。
 */
import type { z } from 'zod';
import {
  BundleInput,
  DossierInput,
  EntityInput,
  KNOWN_KEYS,
  RelationInput,
  type RelationObjectInput,
  detectDocKind,
} from './schema.ts';
import {
  CONFIDENCE,
  CONFIDENCE_KEYS,
  FORBIDDEN_FIELDS,
  MINOR_AGE,
  RELATION_TYPES,
  type Confidence,
  relationDef,
} from './vocab.ts';
import {
  GRAPH_SCHEMA_VERSION,
  type Dossier,
  type DossierMember,
  type Entity,
  type GraphData,
  type Issue,
  type LayerInfo,
  type Position,
  type Relation,
  type Source,
} from './types.ts';
import { hasCJK, normalizeSource, searchKeys, sourceKey, toArray, uniq, uniqBy, yearOf } from './util.ts';
import { computeMetrics } from './algo/metrics.ts';

export interface LayerConfig {
  id: string;
  name?: string;
  /** 相对 data/ 的目录 */
  path: string;
  /** 合并优先级，数值越大越权威（curated 应最高） */
  priority: number;
  license?: string;
  description?: string;
  defaultConfidence?: Confidence;
  /** 人工精编层：缺少来源会报警告、悬空引用会报错 */
  curated?: boolean;
  /** 大体量层（数万实体以上）：其中低层级实体不进入浏览器默认加载的核心子图，按需经本地 API 获取 */
  bulk?: boolean;
  enabled?: boolean;
}

export interface RawDoc {
  layer: string;
  /** 相对 data/ 的路径，例如 curated/persons/xi-jinping.yaml */
  file: string;
  data: unknown;
}

export interface CompileOptions {
  layers: LayerConfig[];
  now?: Date;
  /** 计算 PageRank/社区（较慢，默认开启） */
  metrics?: boolean;
}

interface Ctx {
  layer: LayerConfig;
  file: string;
}
interface EntityFrag extends Ctx {
  input: EntityInput;
  inherited: Source[];
}
interface RelFrag extends Ctx {
  input: RelationObjectInput;
  defaults: { sources: Source[]; confidence?: Confidence };
  dossier?: string;
  derived?: boolean;
}
interface DossierFrag extends Ctx {
  input: DossierInput;
}

const FORBIDDEN = new Set(FORBIDDEN_FIELDS.map((f) => f.toLowerCase()));
/** 这些关系类型允许同一对端点之间以不同 label 并存（例如在同一机构担任多个职务） */
const LABEL_KEYED = new Set(['position', 'member', 'board', 'advisor', 'donor', 'legal', 'related', 'associate', 'client']);
const TERM_KEYED = new Set(['position', 'member', 'board']);

function zodMsg(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function scanForbidden(node: unknown, path: string, hit: (p: string) => void, depth = 0) {
  if (depth > 6 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanForbidden(v, `${path}[${i}]`, hit, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN.has(k.toLowerCase())) hit(`${path}.${k}`);
    scanForbidden(v, `${path}.${k}`, hit, depth + 1);
  }
}

function tupleToObject(t: unknown[]): RelationObjectInput {
  const [from, type, to, label, conf] = t as string[];
  const out: RelationObjectInput = { from, type: type as RelationObjectInput['type'], to };
  if (label) out.label = label;
  if (conf && (CONFIDENCE_KEYS as string[]).includes(conf)) out.confidence = conf as Confidence;
  else if (conf) out.note = conf;
  return out;
}

export function compile(docs: RawDoc[], opts: CompileOptions): GraphData {
  const now = opts.now ?? new Date();
  const issues: Issue[] = [];
  const layers = new Map(opts.layers.filter((l) => l.enabled !== false).map((l) => [l.id, l]));
  const entityFrags: EntityFrag[] = [];
  const relFrags: RelFrag[] = [];
  const dossierFrags: DossierFrag[] = [];

  const push = (level: Issue['level'], code: string, message: string, file?: string, id?: string) =>
    issues.push({ level, code, message, file, id });

  const warnUnknownKeys = (obj: unknown, known: string[], file: string, what: string) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (!known.includes(k) && k !== 'type' && k !== 'kind') {
        push('warn', 'unknown-key', `${what} 含未知字段 "${k}"（可能拼写错误；自定义数据请放进 attrs）`, file);
      }
    }
  };

  // ---------- 1. 解析 ----------
  const addRelations = (
    list: unknown[] | undefined,
    ctx: Ctx,
    defaults: RelFrag['defaults'],
    where: string,
    dossier?: string,
  ) => {
    (list ?? []).forEach((r, i) => {
      const parsed = RelationInput.safeParse(r);
      if (!parsed.success) {
        push('error', 'schema', `${where} relations[${i}] 无效：${zodMsg(parsed.error)}`, ctx.file);
        return;
      }
      const obj = Array.isArray(parsed.data) ? tupleToObject(parsed.data) : parsed.data;
      if (!Array.isArray(parsed.data)) warnUnknownKeys(r, KNOWN_KEYS.relation, ctx.file, `relations[${i}]`);
      relFrags.push({ ...ctx, input: obj, defaults, dossier });
    });
  };

  const addEntity = (raw: unknown, ctx: Ctx, inherited: Source[], where: string) => {
    const parsed = EntityInput.safeParse(raw);
    if (!parsed.success) {
      push('error', 'schema', `${where} 无效：${zodMsg(parsed.error)}`, ctx.file, (raw as { id?: string })?.id);
      return;
    }
    warnUnknownKeys(raw, KNOWN_KEYS[parsed.data.type], ctx.file, where);
    entityFrags.push({ ...ctx, input: parsed.data, inherited });
  };

  const addDossier = (raw: unknown, ctx: Ctx, where: string) => {
    const parsed = DossierInput.safeParse(raw);
    if (!parsed.success) {
      push('error', 'schema', `${where} 无效：${zodMsg(parsed.error)}`, ctx.file, (raw as { id?: string })?.id);
      return;
    }
    warnUnknownKeys(raw, KNOWN_KEYS.dossier, ctx.file, where);
    const d = parsed.data;
    dossierFrags.push({ ...ctx, input: d });
    const srcs = (d.sources ?? []).map((s) => normalizeSource(s, ctx.layer.id));
    addRelations(d.relations, ctx, { sources: srcs, confidence: d.confidence }, `dossier ${d.id}`, d.id);
  };

  for (const doc of docs) {
    const layer = layers.get(doc.layer);
    if (!layer) continue;
    const ctx: Ctx = { layer, file: doc.file };
    scanForbidden(doc.data, '$', (p) =>
      push('error', 'privacy', `发现隐私红线字段 ${p}（禁止收录住址/电话/证件号等），该字段已被丢弃`, doc.file),
    );
    const kind = detectDocKind(doc.data);
    if (!kind) {
      push('warn', 'unknown-doc', '无法识别的数据文件（需要 id+type、id+kind，或 entities/relations/dossiers 字段）', doc.file);
      continue;
    }
    if (kind === 'entity') addEntity(doc.data, ctx, [], 'entity');
    else if (kind === 'dossier') addDossier(doc.data, ctx, 'dossier');
    else {
      const d = doc.data as Record<string, unknown>;
      const head = BundleInput.pick({ sources: true, confidence: true }).safeParse({
        sources: d.sources,
        confidence: d.confidence,
      });
      if (!head.success) {
        push('error', 'schema', `bundle 头部无效：${zodMsg(head.error)}`, doc.file);
        continue;
      }
      warnUnknownKeys(d, KNOWN_KEYS.bundle, doc.file, 'bundle');
      const srcs = (head.data.sources ?? []).map((s) => normalizeSource(s, layer.id));
      toArray(d.entities as unknown[]).forEach((e, i) => addEntity(e, ctx, srcs, `entities[${i}]`));
      toArray(d.dossiers as unknown[]).forEach((x, i) => addDossier(x, ctx, `dossiers[${i}]`));
      addRelations(d.relations as unknown[], ctx, { sources: srcs, confidence: head.data.confidence }, 'bundle');
    }
  }

  // ---------- 2. 身份合并（同 id 或同外部 ID 视为同一实体） ----------
  const uf = entityFrags.map((_, i) => i);
  const find = (i: number): number => (uf[i] === i ? i : (uf[i] = find(uf[i])));
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) uf[rb] = ra;
  };
  const byKey = new Map<string, number>();
  entityFrags.forEach((f, i) => {
    const keys = [
      `id:${f.input.id}`,
      ...Object.entries(f.input.ids ?? {}).map(([k, v]) => `ext:${k}:${String(v).toLowerCase()}`),
      ...toArray(f.input.sameAs).map((x) => `id:${x}`),
    ];
    for (const k of keys) {
      const j = byKey.get(k);
      if (j === undefined) byKey.set(k, i);
      else union(j, i);
    }
  });
  const clusters = new Map<number, EntityFrag[]>();
  entityFrags.forEach((f, i) => {
    const r = find(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(f);
  });

  const alias = new Map<string, string>(); // 任意 id → 规范 id
  const entities = new Map<string, Entity>();
  const curatedIdsSeen = new Map<string, string>();

  for (const frags of clusters.values()) {
    frags.sort((a, b) => b.layer.priority - a.layer.priority || a.file.localeCompare(b.file));
    const canonical = frags[0].input.id;
    for (const f of frags) {
      alias.set(f.input.id, canonical);
      if (f.layer.curated) {
        const prev = curatedIdsSeen.get(f.input.id);
        if (prev && prev !== f.file) push('error', 'duplicate-id', `id "${f.input.id}" 在精编层重复定义（${prev}）`, f.file, f.input.id);
        curatedIdsSeen.set(f.input.id, f.file);
      }
    }
    const otherIds = uniq(frags.map((f) => f.input.id)).filter((x) => x !== canonical);
    if (otherIds.length) push('info', 'merged', `合并同一实体：${otherIds.join(', ')} → ${canonical}`, frags[0].file, canonical);
    entities.set(canonical, mergeEntity(canonical, frags, push));
  }

  // ---------- 3. 派生关系（positions / education / parent org） ----------
  for (const e of entities.values()) {
    const frag0: Ctx = { layer: layers.get(e.layers[0])!, file: e.files[0] };
    for (const p of e.positions ?? []) {
      if (!p.org) continue;
      relFrags.push({
        ...frag0,
        derived: true,
        input: {
          from: e.id,
          to: p.org,
          type: 'position',
          label: p.title,
          since: p.from,
          until: p.to ?? undefined,
          current: p.current ?? (p.to === null ? true : undefined),
          confidence: p.confidence,
        },
        defaults: { sources: p.sources?.length ? p.sources : e.sources.slice(0, 2) },
      });
    }
    for (const ed of e.education ?? []) {
      relFrags.push({
        ...frag0,
        derived: true,
        input: { from: e.id, to: ed.org, type: 'alumni', label: [ed.degree, ed.field].filter(Boolean).join(' ') || undefined, since: ed.from, until: ed.to ?? undefined },
        defaults: { sources: e.sources.slice(0, 1) },
      });
    }
    if (e.type === 'org' && e.parent) {
      relFrags.push({
        ...frag0,
        derived: true,
        input: { from: e.parent, to: e.id, type: 'parent-org' },
        defaults: { sources: e.sources.slice(0, 1) },
      });
    }
  }

  // ---------- 4. 未成年人策略 ----------
  const thisYear = now.getUTCFullYear();
  const excluded = new Set<string>();
  for (const e of [...entities.values()]) {
    if (e.type !== 'person') continue;
    const by = yearOf(e.born);
    if (by && !e.died && thisYear - by < MINOR_AGE) {
      const curated = e.layers.some((l) => layers.get(l)?.curated);
      push(curated ? 'error' : 'info', 'minor', `未成年人（${e.born}）不得收录，已从图中排除`, e.files[0], e.id);
      entities.delete(e.id);
      excluded.add(e.id);
    }
  }

  // ---------- 5. 关系归一 + 去重 ----------
  const dossierRelEndpoints = new Map<string, Set<string>>();
  const dossierEndpoints = (dossierId: string, a: string, b: string) => {
    const set = dossierRelEndpoints.get(dossierId) ?? new Set<string>();
    set.add(a);
    set.add(b);
    dossierRelEndpoints.set(dossierId, set);
  };
  const relMap = new Map<string, { rel: Relation; priority: number }>();
  const retractions: { from: string; to: string; type: string; label?: string; priority: number; file: string }[] = [];
  let dropped = 0;
  for (const rf of relFrags) {
    const r = rf.input;
    const from = alias.get(r.from) ?? r.from;
    const to = alias.get(r.to) ?? r.to;
    const def = relationDef(r.type);
    if (r.retract) {
      retractions.push({ from, to, type: r.type, label: r.label, priority: rf.layer.priority, file: rf.file });
      continue;
    }
    const missing = [from, to].filter((x) => !entities.has(x));
    if (missing.length) {
      dropped++;
      // 指向被策略剔除（未成年人）的实体：静默丢弃
      if (missing.every((m) => excluded.has(m))) continue;
      if (rf.layer.curated || !rf.derived)
        push(rf.layer.curated ? 'error' : 'warn', 'dangling', `关系 ${r.from} -[${r.type}]-> ${r.to} 引用了不存在的实体：${missing.join(', ')}`, rf.file);
      continue;
    }
    if (from === to) {
      push('warn', 'self-loop', `关系指向自身：${from} ${r.type}`, rf.file);
      continue;
    }
    const fe = entities.get(from)!, te = entities.get(to)!;
    if (
      (def.ends === 'pp' && (fe.type !== 'person' || te.type !== 'person')) ||
      (def.ends === 'po' && te.type !== 'org') ||
      (def.ends === 'oo' && (fe.type !== 'org' || te.type !== 'org'))
    ) {
      push('warn', 'ends', `关系 ${from} -[${r.type}]-> ${to} 的端点类型与词表约定（${def.ends}）不符`, rf.file);
    }
    let [a, b] = [from, to];
    if (!def.directed && a > b) [a, b] = [b, a];
    // 职务/成员/董事：同一机构的不同任期分开（按起始年份区分），避免把 2017–2021 与 2025– 合并成一条
    const termKey = TERM_KEYED.has(r.type) && r.since ? `|${yearOf(r.since)}` : '';
    const key = `${r.type}|${a}|${b}` + (LABEL_KEYED.has(r.type) ? `|${(r.label ?? '').trim()}` : '') + termKey;
    const srcs = (r.sources?.length ? r.sources.map((s) => normalizeSource(s, rf.layer.id)) : rf.defaults.sources).map((s) =>
      s.layer ? s : { ...s, layer: rf.layer.id },
    );
    const conf: Confidence =
      r.confidence ?? rf.defaults.confidence ?? rf.layer.defaultConfidence ?? (srcs.length ? 'reported' : 'rumor');
    if (rf.layer.curated && !rf.derived && !srcs.length)
      push('warn', 'no-source', `关系 ${from} -[${r.type}]-> ${to} 没有来源`, rf.file);

    const existing = relMap.get(key);
    if (!existing) {
      relMap.set(key, {
        priority: rf.layer.priority,
        rel: {
          id: key.replace(/\|/g, '~'),
          from: a,
          to: b,
          type: r.type,
          category: def.category,
          directed: def.directed,
          label: r.label,
          since: r.since ?? undefined,
          until: r.until ?? undefined,
          current: r.current,
          confidence: conf,
          sources: uniqBy(srcs, sourceKey),
          note: r.note,
          attrs: r.attrs,
          layer: rf.layer.id,
          file: rf.file,
          derived: rf.derived || undefined,
        },
      });
      if (rf.dossier) dossierEndpoints(rf.dossier, a, b);
    } else {
      const ex = existing.rel;
      const higher = rf.layer.priority > existing.priority;
      ex.sources = uniqBy([...ex.sources, ...srcs], sourceKey);
      if (higher) {
        ex.label = r.label ?? ex.label;
        ex.since = r.since ?? ex.since;
        ex.until = r.until ?? ex.until;
        ex.current = r.current ?? ex.current;
        if (r.confidence || rf.defaults.confidence) ex.confidence = conf;
        ex.layer = rf.layer.id;
        ex.file = rf.file;
        existing.priority = rf.layer.priority;
      } else {
        ex.label ??= r.label;
        ex.since ??= r.since ?? undefined;
        ex.until ??= r.until ?? undefined;
        ex.note ??= r.note;
      }
      if (!rf.derived) ex.derived = undefined;
      if (rf.dossier) dossierEndpoints(rf.dossier, a, b);
    }
  }
  if (dropped) push('info', 'dropped-relations', `共丢弃 ${dropped} 条引用缺失实体的关系`);

  // 任期合并：同一人在同一机构、同一职务的连续任期合并为一段；中断超过 1 年的任期保持分开
  const termGroups = new Map<string, string[]>();
  for (const [key, v] of relMap) {
    if (!TERM_KEYED.has(v.rel.type)) continue;
    const base = key.replace(/\|-?\d+$/, '');
    (termGroups.get(base) ?? termGroups.set(base, []).get(base)!).push(key);
  }
  for (const [base, keys] of termGroups) {
    if (keys.length < 2) continue;
    const items = keys.map((k) => ({ k, v: relMap.get(k)! })).sort((x, y) => (yearOf(x.v.rel.since) ?? 0) - (yearOf(y.v.rel.since) ?? 0));
    let cur = items[0];
    for (const it of items.slice(1)) {
      const curEnd = yearOf(cur.v.rel.until);
      const nextStart = yearOf(it.v.rel.since);
      const contiguous = curEnd !== undefined && nextStart !== undefined && nextStart - curEnd <= 1;
      if (contiguous) {
        cur.v.rel.until = it.v.rel.until;
        cur.v.rel.current = it.v.rel.current ?? cur.v.rel.current;
        cur.v.rel.sources = uniqBy([...cur.v.rel.sources, ...it.v.rel.sources], sourceKey);
        relMap.delete(it.k);
      } else cur = it;
    }
    void base;
  }
  for (const rt of retractions) {
    let n = 0;
    for (const [key, v] of relMap) {
      const r = v.rel;
      const same =
        r.type === rt.type &&
        ((r.from === rt.from && r.to === rt.to) || (!r.directed && r.from === rt.to && r.to === rt.from)) &&
        (!rt.label || r.label === rt.label);
      if (same && v.priority < rt.priority) {
        relMap.delete(key);
        n++;
      }
    }
    push('info', 'retract', `撤回 ${n} 条关系 ${rt.from} -[${rt.type}]-> ${rt.to}`, rt.file);
  }

  // ---------- 6. 档案（家族/派系…） ----------
  const dossiers = mergeDossiers(dossierFrags, alias, entities, dossierRelEndpoints, push);
  for (const d of dossiers) for (const m of d.members) entities.get(m.id)?.dossiers.push(d.id);

  // ---------- 6a. 链接格式检查（例如 YAML 行内列表把含逗号的 URL 拆成两半） ----------
  const urlOk = (u: string) => /^https?:\/\/[^\s]+$/.test(u);
  for (const e of entities.values()) {
    for (const u of [...e.links, ...(e.sources.map((s) => s.url).filter(Boolean) as string[])]) {
      if (!urlOk(u)) push('warn', 'bad-url', `实体 ${e.id} 含无效链接 "${u}"（含逗号的 URL 在 YAML 行内列表中需加引号）`, e.files[0], e.id);
    }
  }
  for (const v of relMap.values()) {
    for (const s of v.rel.sources) if (s.url && !urlOk(s.url)) push('warn', 'bad-url', `关系 ${v.rel.id} 含无效来源链接 "${s.url}"`, v.rel.file);
  }

  // ---------- 6b. 疑似重复：同名 + 出生年份相近，但 id 不同（distinctFrom 声明的除外） ----------
  const distinct = new Set<string>();
  for (const f of entityFrags) {
    const me = alias.get(f.input.id) ?? f.input.id;
    for (const o of f.input.distinctFrom ?? []) {
      const other = alias.get(o) ?? o;
      distinct.add(`${me}|${other}`);
      distinct.add(`${other}|${me}`);
    }
  }
  const nameKey = new Map<string, string[]>();
  for (const e of entities.values()) {
    if (e.type !== 'person') continue;
    const by = yearOf(e.born);
    for (const n of new Set([e.names.zh, e.names.en].filter(Boolean) as string[])) {
      const k = n.toLowerCase().replace(/[\s.·・-]/g, '');
      if (k.length < 2) continue;
      for (const y of by ? [by - 1, by, by + 1] : []) {
        const key = `${k}|${y}`;
        (nameKey.get(key) ?? nameKey.set(key, []).get(key)!).push(e.id);
      }
    }
  }
  const reported = new Set<string>();
  /** 明显不同的人：中文名都有但不同（拼音同名），或各有不同的 Wikidata QID */
  const clearlyDistinct = (a: string, b: string) => {
    if (distinct.has(`${a}|${b}`)) return true;
    const ea = entities.get(a)!, eb = entities.get(b)!;
    if (ea.names.zh && eb.names.zh && ea.names.zh !== eb.names.zh) return true;
    return !!(ea.ids.wikidata && eb.ids.wikidata && ea.ids.wikidata !== eb.ids.wikidata);
  };
  for (const [key, ids] of nameKey) {
    const all = uniq(ids);
    // 只保留至少与一个其他候选“不明显不同”的 id
    const u = all.filter((a) => all.some((b) => b !== a && !clearlyDistinct(a, b)));
    if (u.length < 2) continue;
    const pair = u.slice().sort().join(',');
    if (reported.has(pair)) continue;
    reported.add(pair);
    push('warn', 'possible-duplicate', `疑似同一人：${u.join(' / ')}（${key.split('|')[0]}）。确认后在精编层给其中一个加上另一方的外部 ID，或统一 id`, entities.get(u[0])?.files[0]);
  }

  // ---------- 7. 度量 ----------
  const relations = [...relMap.values()].map((x) => x.rel);
  const entityList = [...entities.values()];
  for (const r of relations) {
    entities.get(r.from)!.degree++;
    entities.get(r.to)!.degree++;
  }
  if (opts.metrics !== false) computeMetrics(entityList, relations);

  // ---------- 8. 统计 ----------
  const count = <T,>(arr: T[], key: (t: T) => string | string[] | undefined) => {
    const out: Record<string, number> = {};
    for (const x of arr) for (const k of toArray(key(x))) if (k) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  const layerInfos: LayerInfo[] = [...layers.values()].map((l) => ({
    id: l.id,
    name: l.name ?? l.id,
    priority: l.priority,
    license: l.license,
    description: l.description,
    defaultConfidence: l.defaultConfidence,
    bulk: l.bulk,
    entityCount: entityList.filter((e) => e.layers.includes(l.id)).length,
    relationCount: relations.filter((r) => r.layer === l.id).length,
  }));
  const allSources = new Set<string>();
  for (const e of entityList) for (const s of e.sources) allSources.add(sourceKey(s));
  for (const r of relations) for (const s of r.sources) allSources.add(sourceKey(s));

  const order: Record<Issue['level'], number> = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);

  return {
    meta: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      layers: layerInfos,
      counts: {
        entities: entityList.length,
        persons: entityList.filter((e) => e.type === 'person').length,
        orgs: entityList.filter((e) => e.type === 'org').length,
        relations: relations.length,
        dossiers: dossiers.length,
        sources: allSources.size,
        byCountry: count(entityList, (e) => e.country),
        bySector: count(entityList, (e) => e.sectors),
        byCategory: count(relations, (r) => r.category),
        byConfidence: count(relations, (r) => r.confidence),
      },
      issues: {
        errors: issues.filter((i) => i.level === 'error').length,
        warnings: issues.filter((i) => i.level === 'warn').length,
      },
    },
    entities: entityList,
    relations,
    dossiers,
    issues,
  };
}

// ======================================================================

type PushFn = (level: Issue['level'], code: string, message: string, file?: string, id?: string) => void;

function mergeEntity(id: string, frags: EntityFrag[], push: PushFn): Entity {
  const top = frags[0].input;
  const e: Entity = {
    id,
    type: top.type,
    name: top.name,
    names: {},
    aliases: [],
    country: [],
    sectors: [],
    ids: {},
    links: [],
    tags: [],
    sources: [],
    layers: [],
    files: [],
    dossiers: [],
    degree: 0,
    score: 0,
    search: [],
  };
  const positions: Position[] = [];
  const scalarKeys = [
    'tier', 'summary', 'notes', 'updated', 'gender', 'born', 'died', 'birthplace', 'status', 'netWorth',
    'orgType', 'founded', 'dissolved', 'parent', 'hq',
  ] as const;
  const rec = e as unknown as Record<string, unknown>;

  for (const f of frags) {
    const inp = f.input as Record<string, unknown> & EntityInput;
    if (inp.type !== e.type) {
      push('error', 'type-conflict', `实体 ${id} 在不同层中类型冲突（${e.type} vs ${inp.type}），已忽略低优先级片段`, f.file, id);
      continue;
    }
    e.layers.push(f.layer.id);
    e.files.push(f.file);
    for (const k of scalarKeys) if (rec[k] === undefined && inp[k] !== undefined && inp[k] !== null) rec[k] = inp[k];
    for (const [k, v] of Object.entries(inp.names ?? {})) if (!(k in e.names)) e.names[k] = v;
    for (const [k, v] of Object.entries(inp.ids ?? {})) if (!(k in e.ids)) e.ids[k] = String(v);
    e.aliases.push(...(inp.aliases ?? []), ...(inp.name !== e.name ? [inp.name] : []));
    e.country.push(...toArray(inp.country).map((c) => c.toUpperCase()));
    e.sectors.push(...(inp.sectors ?? []));
    e.links.push(...(inp.links ?? []));
    e.tags.push(...(inp.tags ?? []));
    const own = (inp.sources ?? []).map((s) => normalizeSource(s, f.layer.id));
    e.sources.push(...(own.length ? own : f.inherited));
    if (inp.attrs) {
      const clean = Object.fromEntries(Object.entries(inp.attrs).filter(([k]) => !FORBIDDEN.has(k.toLowerCase())));
      e.attrs = { ...clean, ...(e.attrs ?? {}) };
    }
    if (inp.type === 'person') {
      for (const p of inp.positions ?? []) {
        positions.push({
          ...p,
          to: p.to === undefined ? undefined : p.to,
          sources: p.sources?.map((s) => normalizeSource(s, f.layer.id)),
        });
      }
      if (inp.education?.length && !e.education) e.education = inp.education.map((x) => ({ ...x }));
    }
    if (f.layer.curated && !own.length && !(inp.links ?? []).length && !f.inherited.length && !inp.ids?.wikidata) {
      push('warn', 'no-source', `精编实体 ${id} 没有任何来源（sources/links）`, f.file, id);
    }
  }

  e.aliases = uniq(e.aliases.filter((a) => a && a !== e.name));
  e.country = uniq(e.country);
  e.sectors = uniq(e.sectors);
  if (e.ids.wikidata) e.links.push(`https://www.wikidata.org/wiki/${e.ids.wikidata}`);
  e.links = uniq(e.links);
  e.tags = uniq(e.tags);
  e.sources = uniqBy(e.sources, sourceKey);
  e.layers = uniq(e.layers);
  e.files = uniq(e.files);
  if (e.type === 'person') {
    // 片段已按优先级降序：同一机构 + 同一起始年份只保留最权威层的写法（避免“政治局委员/中国共产党中央政治局委员”重复）
    e.positions = uniqBy(positions, (p) => (p.org && yearOf(p.from) ? `${p.org}|${yearOf(p.from)}` : `${p.title}|${p.org ?? ''}|${p.from ?? ''}`)).sort(
      (a, b) => (yearOf(b.from) ?? 0) - (yearOf(a.from) ?? 0),
    );
    if (!e.status) e.status = e.died ? 'deceased' : undefined;
  }
  if (!e.names.zh && hasCJK(e.name)) e.names.zh = e.name;
  if (!e.names.en && !hasCJK(e.name)) e.names.en = e.name;
  e.search = searchKeys([e.name, ...Object.values(e.names), ...e.aliases]);
  return e;
}

function mergeDossiers(
  frags: DossierFrag[],
  alias: Map<string, string>,
  entities: Map<string, Entity>,
  relEndpoints: Map<string, Set<string>>,
  push: PushFn,
): Dossier[] {
  const byId = new Map<string, DossierFrag[]>();
  for (const f of frags) (byId.get(f.input.id) ?? byId.set(f.input.id, []).get(f.input.id)!).push(f);
  const out: Dossier[] = [];
  for (const [id, list] of byId) {
    list.sort((a, b) => b.layer.priority - a.layer.priority);
    const top = list[0];
    const members = new Map<string, DossierMember>();
    let hasLists = false;
    const addMember = (raw: string | { id: string; role?: string; note?: string }, role: 'core' | 'outer', f: DossierFrag) => {
      const mid = alias.get(typeof raw === 'string' ? raw : raw.id) ?? (typeof raw === 'string' ? raw : raw.id);
      if (!entities.has(mid)) {
        push(f.layer.curated ? 'warn' : 'info', 'dossier-member', `档案 ${id} 的成员 ${mid} 不存在`, f.file, id);
        return;
      }
      if (!members.has(mid)) members.set(mid, { id: mid, role, note: typeof raw === 'string' ? undefined : raw.note });
    };
    for (const f of list) {
      if (f.input.core || f.input.outer) hasLists = true;
      if (f.input.head) addMember(f.input.head, 'core', f);
      for (const m of f.input.core ?? []) addMember(m, 'core', f);
      for (const m of f.input.outer ?? []) addMember(m, 'outer', f);
    }
    for (const mid of relEndpoints.get(id) ?? []) {
      if (!members.has(mid) && entities.has(mid)) members.set(mid, { id: mid, role: hasLists ? 'outer' : 'core' });
    }
    const head = top.input.head ? (alias.get(top.input.head) ?? top.input.head) : undefined;
    out.push({
      id,
      kind: top.input.kind,
      name: top.input.name,
      names: Object.assign({}, ...list.slice().reverse().map((f) => f.input.names ?? {})),
      country: uniq(list.flatMap((f) => toArray(f.input.country).map((c) => c.toUpperCase()))),
      head: head && entities.has(head) ? head : undefined,
      members: [...members.values()],
      summary: list.find((f) => f.input.summary)?.input.summary,
      notes: list.find((f) => f.input.notes)?.input.notes,
      tags: uniq(list.flatMap((f) => f.input.tags ?? [])),
      sources: uniqBy(
        list.flatMap((f) => (f.input.sources ?? []).map((s) => normalizeSource(s, f.layer.id))),
        sourceKey,
      ),
      layer: top.layer.id,
      file: top.file,
      updated: top.input.updated,
    });
  }
  return out.sort((a, b) => b.members.length - a.members.length);
}

export { CONFIDENCE, RELATION_TYPES };
