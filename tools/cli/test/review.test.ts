import { describe, expect, it } from 'vitest';
import { countryMatch, initialsOf, iso2, orgKeys, personKeys, pinyinKeys } from '../src/review/names.ts';
import { familyRel, pickHan } from '../src/connectors/opensanctions.ts';
import { icijDate, roleType } from '../src/connectors/icij.ts';
import { fecName } from '../src/connectors/fec.ts';

const meet = (a: string[], b: string[]) => a.some((k) => b.includes(k));

describe('名字分块键', () => {
  it('姓名顺序、空格、连字符、逗号不影响匹配', () => {
    const base = personKeys('Li Xiaolin');
    for (const v of ['LI XIAOLIN', 'LI XIAO LIN', 'Xiaolin Li', 'LI - Xiao Lin', 'Li Xiao-lin']) expect(meet(base, personKeys(v))).toBe(true);
  });
  it('保留姓/名边界：XU Jianyuan ≠ 袁旭健（Yuan Xujian）', () => {
    expect(meet(personKeys('XU Jianyuan'), pinyinKeys('袁旭健'))).toBe(false);
  });
  it('中文名转拼音键', () => {
    expect(meet(pinyinKeys('李小琳'), personKeys('LI XIAOLIN'))).toBe(true);
    expect(meet(pinyinKeys('欧阳中石'), personKeys('Ouyang Zhongshi'))).toBe(true);
  });
  it('西方姓名：FEC 的 “LAST, FIRST M” 与常规写法', () => {
    expect(meet(personKeys('GRIFFIN, KENNETH C.'), personKeys('Kenneth C. Griffin'))).toBe(true);
    expect(meet(personKeys('SMITH, JOHN'), personKeys('John A. Smith'))).toBe(true);
  });
  it('中间名首字母', () => {
    expect(initialsOf('Adam R. Lee')).toEqual(['r']);
    expect(initialsOf('Adam Lee')).toEqual([]);
  });
  it('机构名去后缀', () => {
    expect(orgKeys('KINGSTON TECHNOLOGY LIMITED')).toEqual(orgKeys('Kingston Technology Co., Ltd.'));
    expect(orgKeys('中国电力国际有限公司')).toEqual(['中国电力国际']);
  });
  it('国家：大中华区视为一体，ISO3 → ISO2', () => {
    expect(iso2('HKG')).toBe('HK');
    expect(countryMatch(['CN'], ['HK'])).toBe(1);
    expect(countryMatch(['CN'], ['US'])).toBe(-1);
    expect(countryMatch(['CN'], [])).toBe(0);
  });
});

describe('OpenSanctions 映射', () => {
  it('中文名：大陆取简体，港台取繁体', () => {
    expect(pickHan(['Li Qiang', '李強', '李强'], ['cn'])).toBe('李强');
    expect(pickHan(['李強', '李强'], ['tw'])).toBe('李強');
    expect(pickHan(['リー・チャン', 'Li'], ['cn'])).toBeUndefined();
  });
  it('Family.relationship 是 relative 相对 person 的身份', () => {
    expect(familyRel('father', 'p', 'r')).toMatchObject({ from: 'r', to: 'p', type: 'parent' });
    expect(familyRel('child', 'p', 'r')).toMatchObject({ from: 'p', to: 'r', type: 'parent' });
    expect(familyRel('spouse', 'p', 'r').type).toBe('spouse');
    expect(familyRel('elder brother', 'p', 'r')).toMatchObject({ type: 'sibling', label: 'elder brother' });
    expect(familyRel('father-in-law', 'p', 'r').type).toBe('in-law');
    expect(familyRel("father's brother", 'p', 'r').type).toBe('relative');
  });
});

describe('ICIJ / FEC 辅助', () => {
  it('ICIJ 日期与角色', () => {
    expect(icijDate('29-JAN-2007')).toBe('2007-01-29');
    expect(icijDate('2010-05-01')).toBe('2010-05-01');
    expect(roleType('shareholder of')).toBe('owner');
    expect(roleType('Beneficial Owner')).toBe('owner');
    expect(roleType('director of')).toBe('board');
    expect(roleType('auditor of')).toBe('related');
  });
  it('FEC 姓名格式化', () => {
    expect(fecName('GRIFFIN, KENNETH C.')).toBe('Kenneth C. Griffin');
  });
});

import { lsDate, mapRel } from '../src/connectors/littlesis.ts';

describe('LittleSis 映射', () => {
  const r = (category_id: number, description1: string | null, description2: string | null, extra: { amount?: number; board?: boolean } = {}) => ({
    category_id,
    description1,
    description2,
    amount: extra.amount ?? null,
    board: extra.board ?? null,
  });
  it('日期中的 00 表示未知', () => {
    expect(lsDate('2007-00-00')).toBe('2007');
    expect(lsDate('2010-06-00')).toBe('2010-06');
    expect(lsDate('0000-00-00')).toBeUndefined();
  });
  it('家族：description1 是 entity1 的身份', () => {
    expect(mapRel(r(4, 'father', 'son'), 'a', 'b', true, true)).toEqual(['a', 'b', 'parent', undefined]);
    expect(mapRel(r(4, 'son', 'father'), 'a', 'b', true, true)).toEqual(['b', 'a', 'parent', undefined]);
    expect(mapRel(r(4, 'husband', 'wife'), 'a', 'b', true, true)?.[2]).toBe('spouse');
    expect(mapRel(r(4, 'son-in-law', 'father-in-law'), 'a', 'b', true, true)?.[2]).toBe('in-law');
  });
  it('隶属：entity1 是下属 → parent-org 从 entity2 指向 entity1', () => {
    expect(mapRel(r(11, 'subsidiary', 'parent'), 'merrill', 'bofa', false, false)).toEqual(['bofa', 'merrill', 'parent-org', 'subsidiary']);
  });
  it('交易：服务方 → 客户', () => {
    expect(mapRel(r(6, 'Lobbying Client', 'Lobbying Firm'), 'client', 'firm', false, false)?.slice(0, 3)).toEqual(['firm', 'client', 'client']);
    expect(mapRel(r(6, 'Contractor', 'Client'), 'contractor', 'af', false, false)?.slice(0, 3)).toEqual(['contractor', 'af', 'client']);
  });
  it('任职与小额捐赠', () => {
    expect(mapRel(r(1, 'Director', 'Director', { board: true }), 'p', 'o', true, false)?.[2]).toBe('board');
    expect(mapRel(r(5, null, null, { amount: 2700 }), 'p', 'o', true, false)).toBeNull();
    expect(mapRel(r(5, null, null, { amount: 250000 }), 'p', 'o', true, false)?.[2]).toBe('donor');
  });
});
