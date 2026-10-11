/**
 * Node 侧的数据访问层：读取 data/ 下的 YAML/JSON，调用 @nexus/core 编译。
 * CLI 与 Vite 开发插件共用这里的函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { compile, coreIds, layoutGraph, subsetGraph, type GraphData, type LayerConfig, type LayoutCache, type RawDoc } from '@nexus/core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA_DIR = process.env.NEXUS_DATA_DIR ? path.resolve(process.env.NEXUS_DATA_DIR) : path.join(ROOT, 'data');
export const CACHE_DIR = path.join(ROOT, '.cache');
export const WEB_DATA_OUT = path.join(ROOT, 'apps/web/public/data');

export function readYaml(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  return YAML.parse(text, { uniqueKeys: false });
}

/** 写 YAML：保持中文可读、长行不折断，便于 AI 与人工 diff */
export function toYaml(obj: unknown): string {
  return YAML.stringify(obj, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN', aliasDuplicateObjects: false });
}

export function writeYaml(file: string, obj: unknown, header?: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (header ? header.replace(/^/gm, '# ') + '\n' : '') + toYaml(obj));
}

export function loadLayers(dataDir = DATA_DIR): LayerConfig[] {
  const f = path.join(dataDir, 'layers.yaml');
  if (!fs.existsSync(f)) return [{ id: 'curated', path: 'curated', priority: 100, curated: true }];
  const doc = readYaml(f) as { layers: LayerConfig[] };
  return doc.layers;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ya?ml|json)$/.test(ent.name)) out.push(p);
  }
  return out;
}

export function loadDocs(dataDir = DATA_DIR, layers = loadLayers(dataDir)): { docs: RawDoc[]; parseErrors: { file: string; message: string }[] } {
  const docs: RawDoc[] = [];
  const parseErrors: { file: string; message: string }[] = [];
  for (const layer of layers) {
    if (layer.enabled === false) continue;
    for (const file of walk(path.join(dataDir, layer.path)).sort()) {
      const rel = path.relative(dataDir, file);
      try {
        docs.push({ layer: layer.id, file: rel, data: readYaml(file) });
      } catch (e) {
        parseErrors.push({ file: rel, message: (e as Error).message.split('\n')[0] });
      }
    }
  }
  return { docs, parseErrors };
}

export interface BuildOptions {
  dataDir?: string;
  layout?: boolean;
  fullLayout?: boolean;
  metrics?: boolean;
}

/** 读取 + 编译 + 布局（坐标缓存在 .cache/layout.json） */
export function buildGraphData(opts: BuildOptions = {}): GraphData {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const layers = loadLayers(dataDir);
  const { docs, parseErrors } = loadDocs(dataDir, layers);
  const data = compile(docs, { layers, metrics: opts.metrics });
  for (const pe of parseErrors) data.issues.unshift({ level: 'error', code: 'yaml', message: `YAML 解析失败：${pe.message}`, file: pe.file });
  data.meta.issues.errors += parseErrors.length;
  if (opts.layout !== false) {
    const cacheFile = path.join(CACHE_DIR, 'layout.json');
    let cache: LayoutCache = {};
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      /* 无缓存 */
    }
    // 只对核心子图做全局布局（bulk 层的低层级实体由前端按需加载时就近摆放）
    const next = layoutGraph(subsetGraph(data, coreIds(data)), cache, { full: opts.fullLayout });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(next));
  }
  return data;
}

/** 给前端的精简版：去掉 UI 用不到的冗余字段（完整数据见 `ctos export`） */
export function slimForWeb(data: GraphData): GraphData {
  const slimSrc = (s: GraphData['relations'][number]['sources'][number]) => {
    const { layer: _l, accessed: _a, ...rest } = s;
    return rest;
  };
  return {
    ...data,
    entities: data.entities.map((e) => ({ ...e, sources: e.sources.map(slimSrc) })),
    relations: data.relations.map(({ file: _f, ...r }) => ({ ...r, sources: r.sources.map(slimSrc) })),
    issues: data.issues.filter((i) => i.level !== 'info'),
  };
}

/** 前端核心子图的 JSON（静态文件与 API /api/core 共用） */
export function coreJson(data: GraphData): string {
  return JSON.stringify(slimForWeb(data.meta.subset ? data : subsetGraph(data, coreIds(data))));
}

/** 写出前端静态数据：核心子图（完整图谱经 `ctos serve` 的 API 按需获取） */
export function writeWebData(data: GraphData, outDir = WEB_DATA_OUT, json = coreJson(data)) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'graph.json'), json);
}
