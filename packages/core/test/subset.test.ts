import { describe, expect, it } from 'vitest';
import { compile, coreIds, mergePatch, subsetGraph, type LayerConfig, type RawDoc } from '../src/index.ts';

const layers: LayerConfig[] = [
  { id: 'curated', path: 'curated', priority: 100, curated: true },
  { id: 'bulk', path: 'imports/bulk', priority: 40, bulk: true },
];
const doc = (layer: string, file: string, data: unknown): RawDoc => ({ layer, file, data });

const data = compile(
  [
    doc('curated', 'curated/a.yaml', { entities: [{ id: 'a', type: 'person', name: 'A', tier: 2, sources: ['https://example.org'] }] }),
    doc('bulk', 'imports/bulk/e.json', {
      entities: [
        { id: 'a', type: 'person', name: 'A' },
        { id: 'b', type: 'person', name: 'B', tier: 3 },
        { id: 'c', type: 'person', name: 'C', tier: 5 },
        { id: 'd', type: 'person', name: 'D', tier: 5 },
      ],
      relations: [['a', 'friend', 'c'], ['c', 'friend', 'd'], ['a', 'friend', 'b']],
    }),
  ],
  { layers, now: new Date('2026-10-11') },
);

describe('核心子图', () => {
  it('非 bulk 层实体 + 低 tier 的 bulk 实体进入核心；关系只保留两端都在核心者', () => {
    const ids = coreIds(data);
    expect([...ids].sort()).toEqual(['a', 'b']);
    const core = subsetGraph(data, ids);
    expect(core.entities.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(core.relations).toHaveLength(1);
    expect(core.meta.subset?.full.entities).toBe(4);
  });

  it('mergePatch 合并补丁、去重，并把无坐标的新实体放到邻居附近', () => {
    const core = subsetGraph(data, coreIds(data));
    for (const e of core.entities) {
      e.x = 100;
      e.y = 100;
    }
    const c = data.entities.find((e) => e.id === 'c')!;
    const rel = data.relations.find((r) => r.to === 'c' || r.from === 'c')!;
    const next = mergePatch(core, { entities: [{ ...c, x: undefined, y: undefined }], relations: [rel] });
    expect(next.entities).toHaveLength(3);
    const placed = next.entities.find((e) => e.id === 'c')!;
    expect(Math.abs(placed.x! - 100)).toBeLessThan(60);
    // 重复合并不产生新对象
    expect(mergePatch(next, { entities: [placed], relations: [rel] })).toBe(next);
  });
});

describe('疑似重复检测', () => {
  const dup = (zhA?: string, zhB?: string) =>
    compile(
      [
        doc('bulk', 'imports/bulk/x.json', {
          entities: [
            { id: 'zhang-ming-1957', type: 'person', name: 'Zhang Ming', names: { en: 'Zhang Ming', ...(zhA ? { zh: zhA } : {}) }, born: '1957' },
            { id: 'zhang-ming-1957-2', type: 'person', name: 'Zhang Ming', names: { en: 'Zhang Ming', ...(zhB ? { zh: zhB } : {}) }, born: '1957' },
          ],
        }),
      ],
      { layers, now: new Date('2026-10-11') },
    ).issues.filter((i) => i.code === 'possible-duplicate');
  it('拼音同名但中文名不同 → 不报', () => expect(dup('张鸣', '张明')).toHaveLength(0));
  it('中文名相同或缺失 → 报', () => {
    expect(dup('张明', '张明')).toHaveLength(1);
    expect(dup()).toHaveLength(1);
  });
});
