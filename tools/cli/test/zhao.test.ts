import { describe, expect, it } from 'vitest';
import { mapDesc } from '../src/connectors/zhao.ts';

describe('zhao 称谓映射（“乙是甲的什么人”）', () => {
  it('子女 → parent(甲→乙)', () => {
    expect(mapDesc('次子', false, false)).toMatchObject({ type: 'parent', from: 'A', label: '次子' });
  });
  it('父/母 → parent(乙→甲)，label 由甲的性别决定', () => {
    expect(mapDesc('父', false, false, 'F')).toMatchObject({ type: 'parent', from: 'B', label: '女' });
  });
  it('配偶/前配偶', () => {
    expect(mapDesc('妻', false, false).type).toBe('spouse');
    expect(mapDesc('前夫', false, false).type).toBe('ex-spouse');
  });
  it('亲属与兄弟姐妹', () => {
    expect(mapDesc('弟', false, false).type).toBe('sibling');
    expect(mapDesc('堂弟', false, false).type).toBe('relative');
    expect(mapDesc('女婿', false, false).type).toBe('in-law');
  });
  it('秘书 → aide(乙→甲)', () => {
    expect(mapDesc('秘书', false, false)).toMatchObject({ type: 'aide', from: 'B' });
  });
  it('公司关系：人一侧为 from；“传闻”降级为 alleged', () => {
    expect(mapDesc('早期股东', false, true)).toMatchObject({ type: 'owner', from: 'A' });
    expect(mapDesc('董事长', true, false)).toMatchObject({ type: 'position', from: 'B' });
    expect(mapDesc('早期大股东\\n传闻为实际控制人', false, true)).toMatchObject({ type: 'owner', confidence: 'alleged' });
  });
});
