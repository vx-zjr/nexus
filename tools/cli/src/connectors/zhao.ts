/**
 * zhao 连接器：导入编程随想《太子党关系网络》(github.com/programthink/zhao, GPL-3.0)
 *
 * 其数据组织方法（本项目的方法论来源）：
 *   person/<姓名>/brief.yaml   一人一档：常用名、曾用名、性别、生卒、简述、链接
 *   company/<名称>/brief.yaml  与权贵相关的公司/组织
 *   family/<家族>.yaml          一族一档：以最显赫者命名；inner=血亲核心，outer=姻亲/关联公司；
 *                               relations=[甲, 乙, 称谓] 三元组（称谓描述“乙是甲的什么人”）
 *   graph.yaml                  按“代际/军衔”把家族分组 —— 即“圈定对象”的策略
 *
 * 用法：npm run ctos -- ingest zhao [--path <zhao仓库目录>]   （缺省自动 git clone 到 .cache/zhao）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { slugify } from '@nexus/core';
import { CACHE_DIR, writeYaml } from '../lib.ts';
import { IdAllocator, type Connector } from './types.ts';

const REPO = 'https://github.com/programthink/zhao';
const LAYER = 'zhao';

interface Brief {
  name: string;
  other_names?: Record<string, string> | null;
  full_name?: string | null;
  sex?: string;
  birth?: number | string;
  death?: number | string | null;
  desc?: string | null;
  links?: string[] | null;
}

const CHILD = /^(子|女|长子|次子|二子|三子|四子|五子|六子|七子|长女|次女|二女|三女|四女|五女|独女|独子|嗣子|养子|养女|遗腹子)$/;
const SIBLING = /(兄|弟|姐|妹)$/;
const RELATIVE = /(侄|甥|孙|叔|伯|舅|姑|姨|祖|表|堂)/;
const COMPANY_OWNER = /(股东|投资人|实际控制人)/;

type Mapped = { type: string; from: 'A' | 'B'; label?: string; confidence?: string };

/** 把 zhao 的称谓翻译成 NEXUS 关系类型。A=三元组第一项，B=第二项，称谓描述“B 是 A 的什么” */
export function mapDesc(desc: string, aIsOrg: boolean, bIsOrg: boolean, aGender?: string): Mapped {
  const d = desc.replace(/\\n/g, ' ').trim();
  const conf = /传闻/.test(d) ? 'alleged' : undefined;
  if (aIsOrg || bIsOrg) {
    const personSide: 'A' | 'B' = aIsOrg ? 'B' : 'A';
    if (aIsOrg && bIsOrg) return { type: 'parent-org', from: 'A', label: d };
    if (COMPANY_OWNER.test(d)) return { type: /投资/.test(d) ? 'investor' : 'owner', from: personSide, label: d, confidence: conf };
    if (d === '成员') return { type: 'member', from: personSide };
    return { type: 'position', from: personSide, label: d, confidence: conf };
  }
  if (CHILD.test(d)) return { type: 'parent', from: 'A', label: d };
  if (d === '父' || d === '母') return { type: 'parent', from: 'B', label: aGender === 'F' ? '女' : aGender === 'M' ? '子' : undefined };
  if (d === '妻' || d === '夫') return { type: 'spouse', from: 'A', label: d };
  if (d === '前妻' || d === '前夫') return { type: 'ex-spouse', from: 'A', label: d };
  if (/女友|情人|情妇/.test(d)) return { type: 'partner', from: 'A', label: d };
  if (/女婿|儿媳|岳|公公|婆婆|连襟|妯娌|亲家/.test(d)) return { type: 'in-law', from: 'A', label: d };
  if (SIBLING.test(d) && !RELATIVE.test(d)) return { type: 'sibling', from: 'A', label: d };
  if (RELATIVE.test(d)) return { type: 'relative', from: 'A', label: d };
  if (d === '秘书' || d === '主席助理') return { type: 'aide', from: 'B', label: d };
  if (d === '学生' || d === '介绍入党') return { type: 'patron', from: 'A', label: d };
  if (d === '铁哥们') return { type: 'friend', from: 'A', label: d };
  if (/同班|同学/.test(d)) return { type: 'classmate', from: 'A', label: d };
  if (d === '生意伙伴') return { type: 'business-partner', from: 'A', label: d };
  return { type: 'associate', from: 'A', label: d };
}

const yearStr = (v: unknown) => (v === undefined || v === null || v === 'N/A' || v === '' ? undefined : String(v));

export const zhaoConnector: Connector = {
  id: 'zhao',
  description: '导入编程随想《太子党关系网络》(GPL-3.0)：~860 人、165 个家族',
  async run({ args, dataDir, log }) {
    const pi = args.indexOf('--path');
    let repo = pi >= 0 ? path.resolve(args[pi + 1]) : path.join(CACHE_DIR, 'zhao');
    if (!fs.existsSync(path.join(repo, 'data'))) {
      log(`克隆 ${REPO} → ${repo}`);
      fs.mkdirSync(path.dirname(repo), { recursive: true });
      execFileSync('git', ['clone', '--depth', '1', REPO, repo], { stdio: 'inherit' });
    }
    const commit = (() => {
      try {
        return execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h %ci'], { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })();
    const ids = new IdAllocator(LAYER, dataDir);
    const read = (f: string) => YAML.parse(fs.readFileSync(f, 'utf8'), { uniqueKeys: false });

    // ---- 人物 / 公司 ----
    const nameToId = new Map<string, string>();
    const genderOf = new Map<string, string>();
    const orgNames = new Set<string>();
    const entities: Record<string, unknown>[] = [];
    const projectSrc = { url: REPO, title: '编程随想《太子党关系网络》', publisher: 'programthink/zhao', note: `GPL-3.0, commit ${commit}` };

    for (const dir of fs.readdirSync(path.join(repo, 'data/person')).sort()) {
      const f = path.join(repo, 'data/person', dir, 'brief.yaml');
      if (!fs.existsSync(f)) continue;
      const b = read(f) as Brief;
      const born = yearStr(b.birth);
      const id = ids.resolve({ type: 'person', name: b.name, names: { zh: b.name }, ids: { zhao: dir }, born });
      nameToId.set(dir, id);
      if (!nameToId.has(b.name)) nameToId.set(b.name, id);
      const gender = b.sex === 'F' ? 'F' : b.sex === 'M' ? 'M' : undefined;
      if (gender) genderOf.set(dir, gender);
      const aliases = Object.values(b.other_names ?? {}).filter(Boolean);
      const en = Object.entries(b.other_names ?? {}).find(([k]) => /英文/.test(k))?.[1];
      entities.push({
        id,
        type: 'person',
        name: b.name,
        names: { zh: b.name, ...(en ? { en } : {}) },
        ...(aliases.length ? { aliases } : {}),
        gender,
        born: born ?? null,
        died: yearStr(b.death) ?? null,
        country: ['CN'],
        summary: (b.desc ?? '').trim() || undefined,
        ids: { zhao: dir },
        links: (b.links ?? []).filter(Boolean),
        sources: [{ ...projectSrc, url: `${REPO}/tree/master/data/person/${encodeURIComponent(dir)}` }],
      });
    }
    for (const dir of fs.readdirSync(path.join(repo, 'data/company')).sort()) {
      const f = path.join(repo, 'data/company', dir, 'brief.yaml');
      if (!fs.existsSync(f)) continue;
      const b = read(f) as Brief;
      const id = ids.resolve({ type: 'org', name: b.name, names: { zh: b.name }, ids: { zhao: `company/${dir}` } });
      nameToId.set(dir, id);
      nameToId.set(b.name, id);
      orgNames.add(dir);
      orgNames.add(b.name);
      entities.push({
        id,
        type: 'org',
        name: b.name,
        names: { zh: b.full_name || b.name },
        orgType: 'company',
        country: ['CN'],
        sectors: ['business'],
        founded: yearStr(b.birth) ?? null,
        summary: (b.desc ?? '').trim() || undefined,
        ids: { zhao: `company/${dir}` },
        links: (b.links ?? []).filter(Boolean),
        sources: [projectSrc],
      });
    }

    // ---- 家族档案 ----
    const groups = (read(path.join(repo, 'data/graph.yaml')) as { name: string; families: string[] }[]) ?? [];
    const familyTags = new Map<string, string[]>();
    for (const g of groups) for (const fam of g.families) (familyTags.get(fam) ?? familyTags.set(fam, []).get(fam)!).push(g.name);

    const dossiers: Record<string, unknown>[] = [];
    let unresolved = 0;
    for (const file of fs.readdirSync(path.join(repo, 'data/family')).sort()) {
      const fam = read(path.join(repo, 'data/family', file)) as { name: string; inner?: string[]; outer?: string[]; relations?: string[][] };
      const ref = (n: string) => {
        const id = nameToId.get(n);
        if (!id) unresolved++;
        return id;
      };
      const head = ref(fam.name);
      const relations: unknown[] = [];
      for (const [a, b, desc] of fam.relations ?? []) {
        const ia = ref(a), ib = ref(b);
        if (!ia || !ib) continue;
        const m = mapDesc(String(desc ?? ''), orgNames.has(a), orgNames.has(b), genderOf.get(a));
        const [from, to] = m.from === 'A' ? [ia, ib] : [ib, ia];
        relations.push({ from, to, type: m.type, ...(m.label ? { label: m.label } : {}), ...(m.confidence ? { confidence: m.confidence } : {}) });
      }
      const famSlug = head ?? slugify(fam.name);
      dossiers.push({
        id: `family-${famSlug}`,
        kind: 'family',
        name: `${fam.name}家族`,
        country: ['CN'],
        ...(head ? { head } : {}),
        core: [head, ...(fam.inner ?? []).map(ref)].filter(Boolean),
        outer: (fam.outer ?? []).map(ref).filter(Boolean),
        tags: ['zhao', ...(familyTags.get(fam.name) ?? [])],
        sources: [{ ...projectSrc, url: `${REPO}/blob/master/data/family/${encodeURIComponent(file)}` }],
        relations,
      });
    }

    const outDir = path.join(dataDir, 'imports', LAYER);
    fs.rmSync(outDir, { recursive: true, force: true });
    const header = `自动生成：ingest zhao（${new Date().toISOString().slice(0, 10)}，源 ${REPO} @ ${commit}）\n许可：GPL-3.0（原作者：编程随想）。请勿手工修改本目录——修订请写到 data/curated/ 覆盖。`;
    writeYaml(path.join(outDir, 'persons.yaml'), { sources: [projectSrc], entities: entities.filter((e) => e.type === 'person') }, header);
    writeYaml(path.join(outDir, 'orgs.yaml'), { sources: [projectSrc], entities: entities.filter((e) => e.type === 'org') }, header);
    // 档案按所属“代际分组”拆分文件，方便查阅
    const byGroup = new Map<string, Record<string, unknown>[]>();
    for (const d of dossiers) {
      const g = ((d.tags as string[])[1] ?? '其他').replace(/[\\/]/g, '-');
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(d);
    }
    for (const [g, list] of byGroup) writeYaml(path.join(outDir, 'families', `${g}.yaml`), { dossiers: list }, header);
    log(`zhao 导入完成：人物 ${entities.filter((e) => e.type === 'person').length}，公司 ${orgNames.size / 2 | 0}+，家族 ${dossiers.length}，未解析引用 ${unresolved}`);
  },
};
