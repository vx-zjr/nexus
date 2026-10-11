/**
 * 大体量导入层的输出工具：写成分片的 JSON 批量文件（{ entities } / { relations }），
 * 比 YAML 解析快一个数量级，仍可被人和 AI 直接阅读。
 */
import fs from 'node:fs';
import path from 'node:path';

export function writeShards(outDir: string, kind: 'entities' | 'relations', items: unknown[], note: string, size = 4000) {
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (let i = 0; i < items.length; i += size) {
    const file = path.join(outDir, `${kind}-${String(n++).padStart(3, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify({ note, [kind]: items.slice(i, i + size) }));
  }
  return n;
}

export function resetDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** 去掉 undefined / 空数组 / 空对象，减小体积 */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length) continue;
    out[k] = v;
  }
  return out as T;
}
