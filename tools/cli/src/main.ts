#!/usr/bin/env -S npx tsx
/**
 * NEXUS CLI —— 给人和 AI 代理使用的统一入口。
 *   npm run ctos -- <命令> [参数]
 * 运行 `npm run ctos -- help` 查看全部命令。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CONFIDENCE,
  COUNTRIES,
  EXPORT_FORMATS,
  type ExportFormat,
  NexusIndex,
  RELATION_TYPES,
  SECTORS,
  entityProfile,
  exportGraph,
  relationDef,
  slugify,
  toFtMJsonl,
  type Confidence,
  type GraphData,
} from '@nexus/core';
import { DATA_DIR, ROOT, buildGraphData, writeWebData, writeYaml } from './lib.ts';
import { CONNECTORS } from './connectors/index.ts';
import { searchEntities } from './connectors/wikidata.ts';
import { runWarehouse } from './warehouse/cli.ts';
import { runReview } from './review/cli.ts';
import { runGuarded } from './guard.ts';

const HELP = `
NEXUS CLI  —  人脉/权力关系情报中心

数据维护
  validate [--strict]            校验全部数据（模式、引用、隐私红线、未成年人），有错误则退出码 1
  build [--full-layout]          编译数据 → apps/web/public/data/graph.json（核心子图，含布局）
  serve [--port 5318]            本地 API：内存中持有完整图谱，前端按需查询；data/ 变动自动重编译
  new person|org <id> --name <名字> [--en <英文名>] [--country CN] [--sectors politics,business]
                                 在 data/curated 下生成实体模板文件
  issues [--level error|warn|info] [--code <code>] [--limit N]

查询（AI 代理在新增数据前必须先查重）
  find <关键词> [--limit N]       按中文/英文/拼音/首字母/别名搜索
  show <id> [--json]             输出实体档案（Markdown，含关系与来源）
  path <id-a> <id-b> [--k 3]     两人之间的最短关系路径
  dossier <id>                   查看档案（家族/派系）成员与内部关系
  stats                          数据规模统计 + 影响力 Top 榜
  todo [--limit N]               研究待办：高影响力但资料薄弱的实体

采集与对接
  warehouse <status|fetch|ingest|search|sql>   原始数据仓库（DuckDB：OpenSanctions/ICIJ/FEC/国会/FJC/LittleSis）
  review <gen|list|decide|stats> 身份匹配审核队列（外部记录 ↔ 图谱人物；nomenklatura 打分）
  wd <名字>                      在 Wikidata 中检索实体，返回 QID（写 ids.wikidata 前必须核实）
  ingest <connector> [选项]       运行数据连接器：${Object.keys(CONNECTORS).join(', ')}
  export <${EXPORT_FORMATS.join('|')}|all> [--out exports] [--min-confidence reported]
                                 ftm = FollowTheMoney（Aleph / OpenSanctions 标准）；--min-confidence 仅对 ftm 生效
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const { values: opt, positionals: pos } = parseArgs({
  args: argv.slice(1),
  allowPositionals: true,
  strict: false,
  options: {
    strict: { type: 'boolean' },
    'full-layout': { type: 'boolean' },
    json: { type: 'boolean' },
    limit: { type: 'string' },
    level: { type: 'string' },
    code: { type: 'string' },
    k: { type: 'string' },
    out: { type: 'string' },
    name: { type: 'string' },
    en: { type: 'string' },
    zh: { type: 'string' },
    country: { type: 'string' },
    sectors: { type: 'string' },
    'min-confidence': { type: 'string' },
    port: { type: 'string' },
  },
});
const num = (v: unknown, d: number) => (v === undefined ? d : Number(v));
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yel: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function load(layout = false): GraphData {
  return buildGraphData({ layout, metrics: true });
}

function summary(data: GraphData) {
  const c = data.meta.counts;
  console.log(
    `${C.cyan('NEXUS')} 实体 ${c.entities}（人物 ${c.persons} / 机构 ${c.orgs}） 关系 ${c.relations} 档案 ${c.dossiers} 来源 ${c.sources}` +
      `  ${data.meta.issues.errors ? C.red(`错误 ${data.meta.issues.errors}`) : '错误 0'} ${C.yel(`警告 ${data.meta.issues.warnings}`)}`,
  );
}

function printIssues(data: GraphData, level?: string, code?: string, limit = 60) {
  const list = data.issues.filter((i) => (!level || i.level === level) && (!code || i.code === code));
  for (const i of list.slice(0, limit)) {
    const tag = i.level === 'error' ? C.red('ERR ') : i.level === 'warn' ? C.yel('WARN') : C.dim('INFO');
    console.log(`${tag} [${i.code}] ${i.message}${i.file ? C.dim(`  ← ${i.file}`) : ''}`);
  }
  if (list.length > limit) console.log(C.dim(`… 另有 ${list.length - limit} 条（--limit 调整）`));
}

/** 重任务（入库、派生表、候选生成、仓库投影、即席 SQL）在资源护栏内运行，避免整机卡死（见 guard.ts） */
const HEAVY = (cmd === 'warehouse' && ['ingest', 'sql'].includes(argv[1])) || (cmd === 'review' && argv[1] === 'gen') || cmd === 'ingest';

async function main() {
  if (HEAVY && runGuarded(`${cmd} ${argv[1] ?? ''}`.trim())) return;
  switch (cmd) {
    case 'validate': {
      const data = load(false);
      printIssues(data, undefined, undefined, 200);
      summary(data);
      const bad = data.meta.issues.errors > 0 || (opt.strict && data.meta.issues.warnings > 0);
      process.exit(bad ? 1 : 0);
    }
    case 'build': {
      const t = Date.now();
      const data = buildGraphData({ layout: true, fullLayout: !!opt['full-layout'] });
      writeWebData(data);
      printIssues(data, 'error');
      summary(data);
      console.log(C.dim(`→ apps/web/public/data/graph.json  (${((Date.now() - t) / 1000).toFixed(1)}s)`));
      return;
    }
    case 'issues': {
      const data = load(false);
      printIssues(data, opt.level as string, opt.code as string, num(opt.limit, 100));
      return;
    }
    case 'find': {
      const q = pos.join(' ');
      const idx = new NexusIndex(load(false));
      const res = idx.search(q, num(opt.limit, 15));
      if (!res.length) console.log(C.dim(`未找到 “${q}”。可用 \`new\` 新建。`));
      for (const e of res) {
        console.log(
          `${C.bold(e.id.padEnd(28))} ${e.name}${e.names.en && e.names.en !== e.name ? ' / ' + e.names.en : ''}  ${C.dim(
            [e.type, e.country.join('/'), e.sectors.join('/'), e.born ? `b.${e.born}` : '', `deg ${e.degree}`].filter(Boolean).join(' · '),
          )}\n${C.dim('    ' + e.files.join(', '))}`,
        );
      }
      return;
    }
    case 'show': {
      const idx = new NexusIndex(load(false));
      const e = idx.get(pos[0]) ?? idx.search(pos.join(' '), 1)[0];
      if (!e) return console.log(C.red(`实体不存在：${pos[0]}`));
      if (opt.json) console.log(JSON.stringify({ entity: e, relations: idx.relationsOf(e.id) }, null, 2));
      else console.log(entityProfile(idx, e));
      return;
    }
    case 'path': {
      const idx = new NexusIndex(load(false));
      const a = idx.get(pos[0]) ?? idx.search(pos[0], 1)[0];
      const b = idx.get(pos[1]) ?? idx.search(pos[1], 1)[0];
      if (!a || !b) return console.log(C.red('请提供两个存在的实体 id 或名字'));
      const paths = idx.paths(a.id, b.id, num(opt.k, 3), { excludeDerived: false });
      if (!paths.length) return console.log(C.dim(`${a.name} 与 ${b.name} 之间没有已知路径`));
      paths.forEach((p, i) => {
        const parts = p.map((s) => {
          const e = idx.get(s.id)!;
          if (!s.via) return C.bold(e.name);
          const def = relationDef(s.via.type);
          const forward = s.via.to === s.id;
          return `${C.dim(`─[${s.via.label ?? (forward ? def.out : def.in)}]→`)} ${C.bold(e.name)}`;
        });
        console.log(`${C.cyan(`#${i + 1}`)} (${p.length - 1} 跳) ${parts.join(' ')}`);
      });
      return;
    }
    case 'dossier': {
      const idx = new NexusIndex(load(false));
      const d = idx.dossierById.get(pos[0]);
      if (!d) {
        console.log('档案列表：');
        for (const x of idx.data.dossiers) console.log(`  ${x.id.padEnd(30)} ${x.name}  ${C.dim(`${x.kind} · ${x.members.length} 人`)}`);
        return;
      }
      console.log(`${C.bold(d.name)} (${d.kind})  ${C.dim(d.file ?? '')}\n${d.summary ?? ''}`);
      for (const m of d.members) console.log(`  ${m.role === 'core' ? '●' : '○'} ${idx.get(m.id)?.name} ${C.dim(m.id)}`);
      for (const r of idx.dossierGraph(d.id).relations) {
        console.log(`  ${idx.get(r.from)?.name} ─[${r.label ?? relationDef(r.type).out}]→ ${idx.get(r.to)?.name} ${C.dim(CONFIDENCE[r.confidence].zh)}`);
      }
      return;
    }
    case 'stats': {
      const data = load(false);
      summary(data);
      const c = data.meta.counts;
      const fmt = (o: Record<string, number>, names?: Record<string, { zh: string }>) =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${names?.[k]?.zh ?? k} ${v}`)
          .join('  ');
      console.log(`数据层   ${data.meta.layers.map((l) => `${l.id}: ${l.entityCount}实体/${l.relationCount}关系`).join('  ')}`);
      console.log(`国家     ${fmt(c.byCountry, COUNTRIES)}`);
      console.log(`领域     ${fmt(c.bySector, SECTORS)}`);
      console.log(`关系类别 ${fmt(c.byCategory)}`);
      console.log(`可信度   ${fmt(c.byConfidence, CONFIDENCE)}`);
      console.log(C.cyan('\n影响力 Top 30'));
      data.entities
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
        .forEach((e, i) => console.log(`${String(i + 1).padStart(3)}. ${e.name.padEnd(16)} ${C.dim(`${e.id} · ${e.country.join('/')} · score ${e.score} · deg ${e.degree}`)}`));
      return;
    }
    case 'todo': {
      const data = load(false);
      const idx = new NexusIndex(data);
      const rows = data.entities
        .filter((e) => e.type === 'person')
        .map((e) => {
          const rels = idx.relationsOf(e.id).filter((r) => !r.derived);
          const fam = rels.filter((r) => r.category === 'family').length;
          const gaps: string[] = [];
          if (!e.summary) gaps.push('无简介');
          if (!e.layers.includes('curated')) gaps.push('未精编');
          if (fam === 0) gaps.push('无家族关系');
          if (e.sources.length + e.links.length < 2) gaps.push('来源<2');
          if (rels.some((r) => CONFIDENCE[r.confidence].rank <= 2)) gaps.push('含待核实关系');
          return { e, gaps, prio: e.score * (gaps.length + 1) };
        })
        .filter((x) => x.gaps.length)
        .sort((a, b) => b.prio - a.prio)
        .slice(0, num(opt.limit, 40));
      console.log(C.cyan('研究待办（按 影响力×缺口 排序）'));
      for (const x of rows) console.log(`  ${x.e.id.padEnd(28)} ${x.e.name.padEnd(12)} ${C.yel(x.gaps.join('、'))}`);
      return;
    }
    case 'new': {
      const kind = pos[0];
      const id = pos[1] ?? (opt.name ? slugify(String(opt.en ?? opt.name)) : undefined);
      if (!['person', 'org'].includes(kind) || !id || !opt.name) {
        console.log('用法：new person|org <id> --name <名字> [--en 英文名] [--country CN] [--sectors politics]');
        process.exit(1);
      }
      const file = path.join(DATA_DIR, 'curated', kind === 'person' ? 'persons' : 'orgs', `${id}.yaml`);
      if (fs.existsSync(file)) return console.log(C.red(`已存在：${path.relative(ROOT, file)}`));
      const names: Record<string, string> = {};
      if (opt.zh) names.zh = String(opt.zh);
      if (opt.en) names.en = String(opt.en);
      const today = new Date().toISOString().slice(0, 10);
      const doc: Record<string, unknown> = {
        id,
        type: kind,
        name: opt.name,
        ...(Object.keys(names).length ? { names } : {}),
        country: String(opt.country ?? 'CN').split(','),
        sectors: String(opt.sectors ?? (kind === 'person' ? 'politics' : 'business')).split(','),
        tier: 3,
        summary: '',
        ...(kind === 'person' ? { gender: 'M', born: null, positions: [] } : { orgType: 'company' }),
        ids: {},
        sources: [],
        updated: today,
      };
      writeYaml(file, doc);
      console.log(`已创建 ${path.relative(ROOT, file)}`);
      return;
    }
    case 'export': {
      const data = buildGraphData({ layout: true });
      const fmts = pos[0] === 'all' || !pos[0] ? EXPORT_FORMATS : [pos[0] as ExportFormat];
      const outDir = path.resolve(ROOT, String(opt.out ?? 'exports'));
      for (const f of fmts) {
        if (!EXPORT_FORMATS.includes(f)) throw new Error(`未知格式 ${f}`);
        const minConf = opt['min-confidence'] as Confidence | undefined;
        if (minConf && !(minConf in CONFIDENCE)) throw new Error(`未知可信度 ${minConf}，可选：${Object.keys(CONFIDENCE).join(', ')}`);
        const files = f === 'ftm' && minConf ? { 'nexus.ftm.json': toFtMJsonl(data, { minConfidence: minConf }) } : exportGraph(data, f);
        for (const [name, content] of Object.entries(files)) {
          const p = path.join(outDir, f, name);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content);
        }
        console.log(`${f.padEnd(9)} → ${path.relative(ROOT, path.join(outDir, f))}/ (${Object.keys(files).length} 个文件)`);
      }
      fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(data));
      return;
    }
    case 'ingest': {
      const name = pos[0];
      const conn = CONNECTORS[name];
      if (!conn) {
        console.log(`可用连接器：\n${Object.entries(CONNECTORS).map(([k, v]) => `  ${k.padEnd(12)} ${v.description}`).join('\n')}`);
        process.exit(name ? 1 : 0);
      }
      await conn.run({ args: argv.slice(2), dataDir: DATA_DIR, log: (m: string) => console.log(m) });
      return;
    }
    case 'serve': {
      const { serve } = await import('./server.ts');
      await serve({ port: opt.port ? Number(opt.port) : undefined });
      return;
    }
    case 'review': {
      await runReview(argv.slice(1), (m) => console.log(m));
      return;
    }
    case 'warehouse': {
      await runWarehouse(argv.slice(1), (m) => console.log(m));
      return;
    }
    case 'wd': {
      const rows = await searchEntities(pos.join(' '));
      for (const r of rows) console.log(`${C.bold(r.item.padEnd(12))} ${r.itemLabel}  ${C.dim([r.d, r.b?.slice(0, 10)].filter(Boolean).join(' · '))}`);
      return;
    }
    case 'vocab': {
      for (const [k, v] of Object.entries(RELATION_TYPES)) console.log(`${k.padEnd(18)} ${v.category.padEnd(13)} ${v.directed ? '→' : '↔'} ${v.desc}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(C.red(String(e?.stack ?? e)));
  process.exit(1);
});
