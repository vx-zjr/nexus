import { describe, expect, it } from 'vitest';
import { compile, toFtM, type LayerConfig } from '../src/index.ts';

const layers: LayerConfig[] = [{ id: 'curated', path: 'curated', priority: 100, curated: true }];
const g = compile(
  [
    {
      layer: 'curated',
      file: 'curated/x.yaml',
      data: {
        sources: ['https://example.org/src'],
        entities: [
          { id: 'a', type: 'person', name: '甲', names: { en: 'A' }, gender: 'M', born: 1950, country: 'CN', sectors: ['politics'], tier: 1, ids: { wikidata: 'Q1' },
            positions: [{ title: '委员', org: 'gov', from: '2020', to: '2024' }] },
          { id: 'b', type: 'person', name: '乙', gender: 'F', country: 'CN', sectors: ['family'] },
          { id: 'gov', type: 'org', name: '某委员会', orgType: 'committee', country: 'CN' },
          { id: 'co', type: 'org', name: '某公司', orgType: 'company', country: 'VG', parent: 'gov' },
          { id: 'ofac', type: 'org', name: 'OFAC', orgType: 'government', country: 'US' },
        ],
        relations: [
          ['a', 'parent', 'b', '长女'],
          { from: 'b', to: 'co', type: 'owner', label: '50%' },
          { from: 'ofac', to: 'a', type: 'legal', label: '制裁（EO 13936）', since: '2020-08-07' },
          { from: 'a', to: 'b', type: 'friend', confidence: 'rumor' },
        ],
      },
    },
  ],
  { layers, now: new Date('2026-10-11'), metrics: false },
);
const ents = toFtM(g);
const one = (schema: string) => ents.filter((e) => e.schema === schema);

describe('FollowTheMoney 导出', () => {
  it('实体映射到正确的 schema 与属性', () => {
    const a = ents.find((e) => e.id === 'nx-a')!;
    expect(a.schema).toBe('Person');
    expect(a.properties).toMatchObject({ name: ['甲'], alias: ['A'], gender: ['male'], birthDate: ['1950'], nationality: ['cn'], wikidataId: ['Q1'] });
    expect(a.properties.topics).toContain('role.pep');
    expect(ents.find((e) => e.id === 'nx-b')!.properties.topics).toContain('role.rca');
    expect(ents.find((e) => e.id === 'nx-gov')!.schema).toBe('PublicBody');
    expect(ents.find((e) => e.id === 'nx-co')!.schema).toBe('Company');
    expect(ents.find((e) => e.id === 'nx-co')!.properties.parent).toEqual(['nx-gov']);
  });
  it('关系映射为 FtM 边实体', () => {
    expect(one('Family')[0].properties).toMatchObject({ person: ['nx-a'], relative: ['nx-b'], relationship: ['子女/child: 长女'] });
    expect(one('Ownership')[0].properties).toMatchObject({ owner: ['nx-b'], asset: ['nx-co'], percentage: ['50'] });
    expect(one('Sanction')[0].properties).toMatchObject({ entity: ['nx-a'], authority: ['OFAC'], listingDate: ['2020-08-07'] });
    const occ = one('Occupancy')[0];
    const pos = ents.find((e) => e.id === occ.properties.post[0])!;
    expect(pos.schema).toBe('Position');
    expect(pos.properties).toMatchObject({ name: ['委员'], organization: ['nx-gov'] });
    expect(occ.properties).toMatchObject({ holder: ['nx-a'], startDate: ['2020'], endDate: ['2024'], status: ['ended'] });
    expect(one('Associate')[0].properties.description[0]).toContain('rumor');
  });
  it('可按可信度过滤', () => {
    expect(toFtM(g, { minConfidence: 'reported' }).some((e) => e.schema === 'Associate')).toBe(false);
  });
});
