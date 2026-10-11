/**
 * 导出器：把 GraphData 转成其他软件能直接使用的格式。
 *   csv      → Excel / pandas / 任意 BI（nodes.csv + edges.csv）
 *   graphml  → Gephi / yEd / Cytoscape / NetworkX
 *   gexf     → Gephi（含动态时间属性）
 *   cypher   → Neo4j / Memgraph
 *   dot      → Graphviz（zhao 项目同款，按档案分图）
 *   jsonl    → LLM / RAG 向量库（每行一个实体的自然语言档案）
 *   markdown → 人和 AI 都能直接阅读的档案
 *   ftm      → FollowTheMoney 实体流（OCCRP Aleph / OpenSanctions 标准），见 ftm.ts
 */
import type { Entity, GraphData, Relation } from '../types.ts';
import { CONFIDENCE, COUNTRIES, PERSON_STATUS, SECTORS, relationDef } from '../vocab.ts';
import { NexusIndex } from '../algo/graph.ts';
import { toFtMJsonl } from './ftm.ts';

export { toFtM, toFtMJsonl, ftmSchemaOf, type FtmEntity, type FtmOptions } from './ftm.ts';

export type ExportFormat = 'csv' | 'graphml' | 'gexf' | 'cypher' | 'dot' | 'jsonl' | 'markdown' | 'ftm';
export const EXPORT_FORMATS: ExportFormat[] = ['csv', 'graphml', 'gexf', 'cypher', 'dot', 'jsonl', 'markdown', 'ftm'];

/** 返回 { 文件名: 内容 } */
export function exportGraph(data: GraphData, format: ExportFormat): Record<string, string> {
  switch (format) {
    case 'csv':
      return toCSV(data);
    case 'graphml':
      return { 'nexus.graphml': toGraphML(data) };
    case 'gexf':
      return { 'nexus.gexf': toGEXF(data) };
    case 'cypher':
      return { 'nexus.cypher': toCypher(data) };
    case 'dot':
      return toDOT(data);
    case 'jsonl':
      return { 'nexus.jsonl': toJSONL(data) };
    case 'markdown':
      return toMarkdown(data);
    case 'ftm':
      return { 'nexus.ftm.json': toFtMJsonl(data) };
  }
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join(';') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(data: GraphData): Record<string, string> {
  const ncols = ['id', 'type', 'name', 'name_zh', 'name_en', 'country', 'sectors', 'tier', 'status', 'born', 'died', 'orgType', 'score', 'degree', 'community', 'dossiers', 'wikidata', 'summary'];
  const nodes = [ncols.join(',')];
  for (const e of data.entities) {
    nodes.push(
      [e.id, e.type, e.name, e.names.zh, e.names.en, e.country, e.sectors, e.tier, e.status, e.born, e.died, e.orgType, e.score, e.degree, e.community, e.dossiers, e.ids.wikidata, e.summary?.replace(/\s+/g, ' ')]
        .map(csvCell)
        .join(','),
    );
  }
  const rcols = ['id', 'from', 'to', 'type', 'category', 'directed', 'label', 'since', 'until', 'confidence', 'layer', 'sources'];
  const edges = [rcols.join(',')];
  for (const r of data.relations) {
    edges.push(
      [r.id, r.from, r.to, r.type, r.category, r.directed, r.label, r.since, r.until, r.confidence, r.layer, r.sources.map((s) => s.url).filter(Boolean)]
        .map(csvCell)
        .join(','),
    );
  }
  return { 'nodes.csv': nodes.join('\n'), 'edges.csv': edges.join('\n') };
}

const xml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function toGraphML(data: GraphData): string {
  const nk = ['type', 'name', 'name_zh', 'name_en', 'country', 'sectors', 'tier', 'score', 'community', 'summary'];
  const ek = ['type', 'category', 'label', 'confidence', 'since', 'until'];
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    ...nk.map((k) => `  <key id="n_${k}" for="node" attr.name="${k}" attr.type="string"/>`),
    ...ek.map((k) => `  <key id="e_${k}" for="edge" attr.name="${k}" attr.type="string"/>`),
    '  <graph id="nexus" edgedefault="directed">',
  ];
  for (const e of data.entities) {
    const vals: Record<string, unknown> = { type: e.type, name: e.name, name_zh: e.names.zh, name_en: e.names.en, country: e.country.join(';'), sectors: e.sectors.join(';'), tier: e.tier, score: e.score, community: e.community, summary: e.summary };
    out.push(`    <node id="${xml(e.id)}">` + nk.map((k) => (vals[k] !== undefined ? `<data key="n_${k}">${xml(vals[k])}</data>` : '')).join('') + '</node>');
  }
  for (const r of data.relations) {
    const vals: Record<string, unknown> = { type: r.type, category: r.category, label: r.label, confidence: r.confidence, since: r.since, until: r.until };
    out.push(`    <edge id="${xml(r.id)}" source="${xml(r.from)}" target="${xml(r.to)}" directed="${r.directed}">` + ek.map((k) => (vals[k] ? `<data key="e_${k}">${xml(vals[k])}</data>` : '')).join('') + '</edge>');
  }
  out.push('  </graph>', '</graphml>');
  return out.join('\n');
}

export function toGEXF(data: GraphData): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gexf xmlns="http://gexf.net/1.3" xmlns:viz="http://gexf.net/1.3/viz" version="1.3">',
    '  <graph defaultedgetype="undirected" mode="static">',
    '    <attributes class="node"><attribute id="0" title="type" type="string"/><attribute id="1" title="country" type="string"/><attribute id="2" title="sector" type="string"/><attribute id="3" title="score" type="float"/></attributes>',
    '    <attributes class="edge"><attribute id="0" title="type" type="string"/><attribute id="1" title="confidence" type="string"/></attributes>',
    '    <nodes>',
  ];
  for (const e of data.entities) {
    const pos = e.x !== undefined ? `<viz:position x="${e.x}" y="${e.y}" z="0"/>` : '';
    out.push(`      <node id="${xml(e.id)}" label="${xml(e.name)}"><attvalues><attvalue for="0" value="${e.type}"/><attvalue for="1" value="${xml(e.country.join(';'))}"/><attvalue for="2" value="${xml(e.sectors[0] ?? '')}"/><attvalue for="3" value="${e.score}"/></attvalues><viz:size value="${2 + e.score * 20}"/>${pos}</node>`);
  }
  out.push('    </nodes>', '    <edges>');
  data.relations.forEach((r, i) => {
    out.push(`      <edge id="${i}" source="${xml(r.from)}" target="${xml(r.to)}" type="${r.directed ? 'directed' : 'undirected'}" label="${xml(r.label ?? relationDef(r.type).en)}"><attvalues><attvalue for="0" value="${r.type}"/><attvalue for="1" value="${r.confidence}"/></attvalues></edge>`);
  });
  out.push('    </edges>', '  </graph>', '</gexf>');
  return out.join('\n');
}

const cy = (s: unknown) => JSON.stringify(s ?? null);
export function toCypher(data: GraphData): string {
  const out = ['// NEXUS → Neo4j。用法：cypher-shell < nexus.cypher', 'CREATE CONSTRAINT nexus_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;'];
  for (const e of data.entities) {
    const label = e.type === 'person' ? 'Person' : 'Org';
    out.push(`MERGE (n:Entity:${label} {id:${cy(e.id)}}) SET n.name=${cy(e.name)}, n.name_zh=${cy(e.names.zh)}, n.name_en=${cy(e.names.en)}, n.country=${cy(e.country)}, n.sectors=${cy(e.sectors)}, n.tier=${cy(e.tier)}, n.score=${cy(e.score)}, n.summary=${cy(e.summary)};`);
  }
  for (const r of data.relations) {
    const rel = r.type.toUpperCase().replace(/-/g, '_');
    out.push(`MATCH (a:Entity {id:${cy(r.from)}}),(b:Entity {id:${cy(r.to)}}) MERGE (a)-[x:${rel} {id:${cy(r.id)}}]->(b) SET x.label=${cy(r.label)}, x.confidence=${cy(r.confidence)}, x.since=${cy(r.since)}, x.until=${cy(r.until)}, x.sources=${cy(r.sources.map((s) => s.url).filter(Boolean))};`);
  }
  return out.join('\n');
}

/** Graphviz：每个档案（家族）一张图，风格致敬 zhao 项目 */
export function toDOT(data: GraphData): Record<string, string> {
  const idx = new NexusIndex(data);
  const files: Record<string, string> = {};
  for (const d of data.dossiers) {
    const { nodes, relations } = idx.dossierGraph(d.id);
    const lines = [`digraph "${d.name}" {`, '  rankdir=TB; bgcolor="#0b0e12"; node [shape=box style="rounded,filled" fillcolor="#121820" fontcolor="#e6f1ff" color="#00e5ff" fontname="Noto Sans CJK SC"]; edge [color="#5c6b7a" fontcolor="#9fb3c8" fontname="Noto Sans CJK SC" fontsize=10];'];
    for (const id of nodes) {
      const e = idx.get(id)!;
      const life = e.type === 'person' ? `${e.born ?? '?'}–${e.died ?? ''}` : '';
      const desc = (e.summary ?? '').split('\n')[0].slice(0, 40);
      lines.push(`  "${id}" [label="${xml(e.name)}\\n${life}\\n${xml(desc)}"${d.members.find((m) => m.id === id)?.role === 'outer' ? ' color="#5c6b7a"' : ''}];`);
    }
    for (const r of relations) {
      const def = relationDef(r.type);
      const lbl = r.label ?? def.out;
      lines.push(`  "${r.from}" -> "${r.to}" [label="${xml(lbl)}"${def.directed ? '' : ' dir=none'}${CONFIDENCE[r.confidence].rank <= 2 ? ' style=dashed' : ''}];`);
    }
    lines.push('}');
    files[`${d.id}.dot`] = lines.join('\n');
  }
  return files;
}

/** 生成一个实体的自然语言档案（Markdown）。AI 读这个比读 JSON 更省 token。 */
export function entityProfile(idx: NexusIndex, e: Entity, opts: { maxRelations?: number } = {}): string {
  const L: string[] = [];
  const names = Object.entries(e.names).map(([k, v]) => `${v}(${k})`).join(' / ');
  L.push(`# ${e.name}  \`${e.id}\``);
  L.push('');
  const meta: string[] = [e.type === 'person' ? '人物' : `机构${e.orgType ? '·' + e.orgType : ''}`];
  if (e.country.length) meta.push(e.country.map((c) => COUNTRIES[c]?.zh ?? c).join('/'));
  if (e.sectors.length) meta.push(e.sectors.map((s) => SECTORS[s]?.zh ?? s).join('/'));
  if (e.tier) meta.push(`T${e.tier}`);
  if (e.status) meta.push(PERSON_STATUS[e.status]);
  if (e.born || e.died) meta.push(`${e.born ?? '?'}–${e.died ?? ''}`);
  L.push(`- ${meta.join(' | ')}`);
  if (names) L.push(`- 姓名：${names}${e.aliases.length ? '；别名：' + e.aliases.join('、') : ''}`);
  if (e.dossiers.length) L.push(`- 档案：${e.dossiers.join(', ')}`);
  if (e.summary) L.push('', e.summary.trim());
  if (e.positions?.length) {
    L.push('', '## 履历');
    for (const p of e.positions) L.push(`- ${p.from ?? '?'}–${p.to === null || p.current ? '今' : (p.to ?? '?')} ${p.title}${p.org ? ` @${p.org}` : ''}`);
  }
  const rels = idx.relationsOf(e.id).filter((r) => !r.derived);
  if (rels.length) {
    L.push('', '## 关系');
    for (const r of rels.slice(0, opts.maxRelations ?? 80)) {
      const def = relationDef(r.type);
      const o = idx.get(idx.other(r, e.id));
      const role = r.from === e.id ? def.out : def.in;
      L.push(`- ${role}${r.label ? `（${r.label}）` : ''}：${o?.name ?? '?'} \`${o?.id}\` [${CONFIDENCE[r.confidence].zh}]`);
    }
  }
  if (e.sources.length || e.links.length) {
    L.push('', '## 来源');
    for (const s of e.sources.slice(0, 12)) L.push(`- ${s.title ?? s.publisher ?? ''} ${s.url ?? ''}`.trim());
    for (const l of e.links.slice(0, 6)) L.push(`- ${l}`);
  }
  L.push('', `> 数据文件：${e.files.join(', ')}`);
  return L.join('\n');
}

export function toJSONL(data: GraphData): string {
  const idx = new NexusIndex(data);
  return data.entities
    .map((e) => JSON.stringify({ id: e.id, type: e.type, name: e.name, country: e.country, sectors: e.sectors, score: e.score, text: entityProfile(idx, e, { maxRelations: 40 }) }))
    .join('\n');
}

export function toMarkdown(data: GraphData): Record<string, string> {
  const idx = new NexusIndex(data);
  const files: Record<string, string> = {};
  for (const e of data.entities) files[`${e.type}/${e.id}.md`] = entityProfile(idx, e);
  return files;
}

export type { Entity, Relation };
