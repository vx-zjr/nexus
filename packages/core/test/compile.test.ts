import { describe, expect, it } from 'vitest';
import { compile, NexusIndex, slugify, type LayerConfig, type RawDoc } from '../src/index.ts';

const layers: LayerConfig[] = [
  { id: 'curated', path: 'curated', priority: 100, curated: true },
  { id: 'imp', path: 'imports/imp', priority: 50, defaultConfidence: 'reported' },
];
const doc = (layer: string, file: string, data: unknown): RawDoc => ({ layer, file, data });
const now = new Date('2026-10-11');

describe('slugify', () => {
  it('中文姓名 → 姓-名拼音', () => {
    expect(slugify('习近平')).toBe('xi-jinping');
    expect(slugify('欧阳中石')).toBe('ouyang-zhongshi');
  });
  it('英文名与机构', () => {
    expect(slugify('Robert F. Kennedy Jr.')).toBe('robert-f-kennedy-jr');
    expect(slugify('万达集团', 'org')).toBe('wan-da-ji-tuan');
  });
});

describe('compile', () => {
  const base = [
    doc('imp', 'imports/imp/a.yaml', {
      entities: [
        { id: 'xi-jinping', type: 'person', name: '习近平', born: 1953, ids: { wikidata: 'Q15031' } },
        { id: 'ke-lingling', type: 'person', name: '柯玲玲' },
        { id: 'kid', type: 'person', name: '某孩子', born: 2015 },
      ],
      relations: [['xi-jinping', 'spouse', 'ke-lingling', '妻'], ['xi-jinping', 'parent', 'kid']],
    }),
    doc('curated', 'curated/persons/xjp.yaml', {
      id: 'xjp', type: 'person', name: '习近平', names: { en: 'Xi Jinping' }, ids: { wikidata: 'Q15031' }, tier: 1, sources: ['https://example.org/a'],
      attrs: { address: 'secret', note: 'ok' },
    }),
    doc('curated', 'curated/relations/fix.yaml', {
      sources: ['https://example.org/b'],
      relations: [
        { from: 'xjp', to: 'ke-lingling', type: 'spouse', retract: true },
        { from: 'xjp', to: 'ke-lingling', type: 'ex-spouse' },
      ],
    }),
  ];
  const g = compile(base, { layers, now });

  it('按外部 ID 合并，规范 id 取精编层', () => {
    const e = g.entities.find((x) => x.ids.wikidata === 'Q15031')!;
    expect(e.id).toBe('xjp');
    expect(e.layers.sort()).toEqual(['curated', 'imp']);
    expect(e.names.en).toBe('Xi Jinping');
    expect(e.tier).toBe(1);
  });
  it('retract 撤回导入层关系，并新增更正关系', () => {
    const types = g.relations.filter((r) => [r.from, r.to].includes('ke-lingling')).map((r) => r.type);
    expect(types).toEqual(['ex-spouse']);
  });
  it('未成年人被剔除，相关关系被丢弃', () => {
    expect(g.entities.some((e) => e.id === 'kid')).toBe(false);
    expect(g.issues.some((i) => i.code === 'minor')).toBe(true);
  });
  it('隐私字段被丢弃并报错', () => {
    const e = g.entities.find((x) => x.id === 'xjp')!;
    expect(e.attrs?.address).toBeUndefined();
    expect(g.issues.some((i) => i.code === 'privacy' && i.level === 'error')).toBe(true);
  });
  it('搜索支持拼音首字母', () => {
    const idx = new NexusIndex(g);
    expect(idx.search('xjp')[0]?.id).toBe('xjp');
    expect(idx.search('ke ling ling')[0]?.id).toBe('ke-lingling');
  });
});

describe('NexusIndex.shortestPath', () => {
  const g = compile(
    [
      doc('curated', 'curated/x.yaml', {
        sources: ['https://example.org'],
        entities: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'person', name: id.toUpperCase() })),
        relations: [['a', 'parent', 'b'], ['b', 'friend', 'c'], ['c', 'spouse', 'd'], ['a', 'colleague', 'd']],
      }),
    ],
    { layers, now, metrics: false },
  );
  it('优先走权重低的关系', () => {
    const idx = new NexusIndex(g);
    const p = idx.shortestPath('a', 'd')!;
    expect(p.map((s) => s.id)).toEqual(['a', 'd']);
    const alt = idx.paths('a', 'd', 3);
    expect(alt.length).toBeGreaterThanOrEqual(1);
  });
});
