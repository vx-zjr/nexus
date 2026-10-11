/**
 * 仓库数据源：每个来源定义“下载什么”和“如何入库（DuckDB 表）”。
 * 新增来源：在 SOURCES 中加一项即可，CLI（ctos warehouse ...）会自动识别。
 *
 * 隐私处理（见 AGENTS.md §0 与 docs/warehouse.md）：
 *   - OpenSanctions：丢弃 Address/Identification/Passport/BankAccount/CryptoWallet 实体；人物去掉住址、电话、邮箱、证件号、税号等字段
 *   - ICIJ：不导入地址节点与“注册地址”关系，实体/中介表去掉 address 列
 *   - FEC：按用户决定原样镜像（含城市/邮编/雇主）；法律禁止将捐款人信息用于募捐或商业目的（52 U.S.C. §30111(a)(4)）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DuckDBConnection } from '@duckdb/node-api';
import { INBOX_DIR, TMP_DIR, all, lit, rawPath, rowCount, setMeta, tableExists } from './db.ts';

export interface DownloadItem {
  url: string;
  /** 相对 raw/ 的路径 */
  file: string;
  optional?: boolean;
}

export interface WarehouseSource {
  id: string;
  name: string;
  license: string;
  description: string;
  downloads(): DownloadItem[];
  /** 需要用户手动放入 inbox 的文件（无法自动下载时） */
  manual?: { dir: string; files: string[]; howto: string };
  ingest(conn: DuckDBConnection, log: (m: string) => void, opts: { only?: string[] }): Promise<Record<string, number>>;
}

const FEC_CYCLES = [2000, 2002, 2004, 2006, 2008, 2010, 2012, 2014, 2016, 2018, 2020, 2022, 2024, 2026];
const FEC_FILES = ['cm', 'cn', 'ccl', 'pas2', 'oth', 'oppexp', 'indiv'] as const;

function unzipTo(zip: string, dir: string): string[] {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit', maxBuffer: 1 << 26 });
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ============================================================ OpenSanctions
const OS_DROP_SCHEMAS = ['Address', 'Identification', 'Passport', 'BankAccount', 'CryptoWallet'];
const OS_PERSON_DROP = ['address', 'addressEntity', 'phone', 'email', 'passportNumber', 'idNumber', 'socialSecurityNumber', 'taxNumber', 'innCode', 'vatCode', 'identification', 'cryptoWallets', 'bankAccounts'];
const OS_ALL_DROP = ['phone', 'email', 'addressEntity', 'bankAccounts', 'cryptoWallets', 'identification'];
/** FtM 边类型的起止属性（与 followthemoney 模型一致） */
const OS_EDGE: Record<string, [string, string | null]> = {
  Family: ['person', 'relative'],
  Associate: ['person', 'associate'],
  Occupancy: ['holder', 'post'],
  Ownership: ['owner', 'asset'],
  Directorship: ['director', 'organization'],
  Membership: ['member', 'organization'],
  Employment: ['employee', 'employer'],
  UnknownLink: ['subject', 'object'],
  Representation: ['agent', 'client'],
  Succession: ['predecessor', 'successor'],
  Payment: ['payer', 'beneficiary'],
  Debt: ['debtor', 'creditor'],
  Sanction: ['entity', null],
};

const opensanctions: WarehouseSource = {
  id: 'opensanctions',
  name: 'OpenSanctions（default 全库）',
  license: 'CC BY-NC 4.0',
  description: '全球政要、亲属关联人、制裁/反制裁、执法与黑名单，FollowTheMoney 格式，每日更新',
  downloads: () => [
    { url: 'https://data.opensanctions.org/datasets/latest/default/index.json', file: 'opensanctions/index.json' },
    { url: 'https://data.opensanctions.org/datasets/latest/default/entities.ftm.json', file: 'opensanctions/entities.ftm.json' },
  ],
  async ingest(conn, log) {
    const file = rawPath('opensanctions/entities.ftm.json');
    let version = '';
    try {
      version = JSON.parse(fs.readFileSync(rawPath('opensanctions/index.json'), 'utf8')).version ?? '';
    } catch {
      /* 无版本信息 */
    }
    log(`读取 ${file}（版本 ${version}）…`);
    const keep = (drop: string[]) => `map_from_entries(list_filter(map_entries(p0), e -> e.key NOT IN (${drop.map(lit).join(',')})))`;
    await conn.run(`CREATE OR REPLACE TABLE os_entities AS
      WITH raw AS (
        SELECT id, schema, caption, datasets, referents, target, first_seen, last_seen, last_change,
               properties::MAP(VARCHAR, VARCHAR[]) AS p0
        FROM read_json(${lit(file)}, format='newline_delimited', maximum_object_size=134217728,
          columns={id:'VARCHAR', caption:'VARCHAR', schema:'VARCHAR', referents:'VARCHAR[]', datasets:'VARCHAR[]',
                   first_seen:'VARCHAR', last_seen:'VARCHAR', last_change:'VARCHAR', target:'BOOLEAN', properties:'JSON'})
        WHERE schema NOT IN (${OS_DROP_SCHEMAS.map(lit).join(',')})
      ), clean AS (
        SELECT * EXCLUDE (p0), CASE WHEN schema = 'Person' THEN ${keep(OS_PERSON_DROP)} ELSE ${keep(OS_ALL_DROP)} END AS props FROM raw
      )
      SELECT id, schema, caption, datasets, referents, target, first_seen, last_seen, last_change, props,
        list_distinct(flatten([coalesce(props['country'], []), coalesce(props['nationality'], []), coalesce(props['citizenship'], []),
                               coalesce(props['jurisdiction'], []), coalesce(props['mainCountry'], [])])) AS countries,
        coalesce(props['topics'], []) AS topics,
        list_distinct(flatten([coalesce(props['name'], []), coalesce(props['alias'], []), coalesce(props['weakAlias'], []), coalesce(props['previousName'], [])])) AS names,
        coalesce(props['wikidataId'][1], CASE WHEN regexp_matches(id, '^Q[0-9]+$') THEN id END) AS qid,
        lower(coalesce(caption, '') || ' | ' || array_to_string(list_distinct(flatten([coalesce(props['name'], []), coalesce(props['alias'], [])])), ' | ')) AS search
      FROM clean`);
    log('建立边索引 os_edges …');
    const srcCase = Object.entries(OS_EDGE).map(([s, [a]]) => `WHEN ${lit(s)} THEN props[${lit(a)}][1]`).join(' ');
    const dstCase = Object.entries(OS_EDGE).map(([s, [, b]]) => `WHEN ${lit(s)} THEN ${b ? `props[${lit(b)}][1]` : 'NULL'}`).join(' ');
    await conn.run(`CREATE OR REPLACE TABLE os_edges AS
      SELECT id, schema, CASE schema ${srcCase} END AS src, CASE schema ${dstCase} END AS dst
      FROM os_entities WHERE schema IN (${Object.keys(OS_EDGE).map(lit).join(',')})`);
    await conn.run(`DELETE FROM os_edges WHERE src IS NULL`);
    await conn.run(`CREATE INDEX IF NOT EXISTS os_entities_id ON os_entities(id)`);
    await conn.run(`CREATE INDEX IF NOT EXISTS os_edges_src ON os_edges(src)`);
    await conn.run(`CREATE INDEX IF NOT EXISTS os_edges_dst ON os_edges(dst)`);
    const tables = { os_entities: await rowCount(conn, 'os_entities'), os_edges: await rowCount(conn, 'os_edges') };
    await setMeta(conn, 'opensanctions', { version, license: this.license, note: '已去除人物隐私字段与 Address 等实体', tables });
    return tables;
  },
};

// ============================================================ ICIJ Offshore Leaks
const icij: WarehouseSource = {
  id: 'icij',
  name: 'ICIJ Offshore Leaks Database',
  license: 'ODbL 1.0（数据库）+ CC BY-SA（内容），须注明 ICIJ',
  description: '离岸解密、巴拿马文件、巴哈马泄密、天堂文件、潘多拉文件：离岸实体、人员、中介及其关系',
  downloads: () => [{ url: 'https://offshoreleaks-data.icij.org/offshoreleaks/csv/full-oldb.LATEST.zip', file: 'icij/full-oldb.LATEST.zip' }],
  async ingest(conn, log) {
    const dir = path.join(TMP_DIR, 'icij');
    log('解压 ICIJ …');
    const files = unzipTo(rawPath('icij/full-oldb.LATEST.zip'), dir);
    const gen = files.map((f) => path.basename(f)).find((f) => f.startsWith('GENERATED_ON_')) ?? '';
    const csv = (name: string) => `read_csv(${lit(path.join(dir, name))}, header=true, all_varchar=true, quote='"', escape='"', strict_mode=false)`;
    await conn.run(`CREATE OR REPLACE TABLE icij_entities AS SELECT * EXCLUDE (address) FROM ${csv('nodes-entities.csv')}`);
    await conn.run(`CREATE OR REPLACE TABLE icij_officers AS SELECT * FROM ${csv('nodes-officers.csv')}`);
    await conn.run(`CREATE OR REPLACE TABLE icij_intermediaries AS SELECT * EXCLUDE (address) FROM ${csv('nodes-intermediaries.csv')}`);
    await conn.run(`CREATE OR REPLACE TABLE icij_others AS SELECT * FROM ${csv('nodes-others.csv')}`);
    // 不导入地址：地址节点、注册地址关系、同地址关系一律跳过
    await conn.run(`CREATE OR REPLACE TABLE icij_relationships AS SELECT * FROM ${csv('relationships.csv')}
      WHERE rel_type NOT IN ('registered_address', 'same_address_as')`);
    await conn.run(`CREATE OR REPLACE VIEW icij_nodes AS
      SELECT node_id, name, 'entity' AS kind, countries, country_codes, sourceID, jurisdiction_description AS detail FROM icij_entities
      UNION ALL SELECT node_id, name, 'officer', countries, country_codes, sourceID, NULL FROM icij_officers
      UNION ALL SELECT node_id, name, 'intermediary', countries, country_codes, sourceID, status FROM icij_intermediaries
      UNION ALL SELECT node_id, name, 'other', countries, country_codes, sourceID, type FROM icij_others`);
    fs.rmSync(dir, { recursive: true, force: true });
    const tables: Record<string, number> = {};
    for (const t of ['icij_entities', 'icij_officers', 'icij_intermediaries', 'icij_others', 'icij_relationships']) tables[t] = await rowCount(conn, t);
    await setMeta(conn, 'icij', { version: gen.replace('GENERATED_ON_', '').replace('.txt', ''), license: this.license, note: '不含地址节点/地址关系/地址列', tables });
    return tables;
  },
};

// ============================================================ FEC
const fec: WarehouseSource = {
  id: 'fec',
  name: '美国联邦选举委员会（FEC）批量数据 2000–2026',
  license: '美国政府公共领域；捐款人信息不得用于募捐或商业目的（52 U.S.C. §30111(a)(4)）',
  description: '委员会、候选人、候选人-委员会关联、委员会对候选人捐款、委员会间往来、运营支出、个人捐款明细（全量原样）',
  downloads: () => [
    ...FEC_FILES.map((f) => ({ url: `https://www.fec.gov/files/bulk-downloads/data_dictionaries/${f}_header_file.csv`, file: `fec/headers/${f}_header_file.csv` })),
    ...FEC_CYCLES.flatMap((y) => FEC_FILES.map((f) => ({ url: `https://www.fec.gov/files/bulk-downloads/${y}/${f}${String(y).slice(2)}.zip`, file: `fec/${y}/${f}${String(y).slice(2)}.zip` }))),
  ],
  async ingest(conn, log, opts) {
    const only = new Set<string>(opts.only?.length ? opts.only : [...FEC_FILES, 'derived']);
    const tables: Record<string, number> = {};
    for (const f of FEC_FILES) {
      if (!only.has(f)) continue;
      const header = fs.readFileSync(rawPath(`fec/headers/${f}_header_file.csv`), 'utf8').trim().split(',').map((h) => h.trim());
      const table = `fec_${f}`;
      const cols = `{${header.map((h) => `${lit(h)}: 'VARCHAR'`).join(', ')}}`;
      await conn.run(`DROP TABLE IF EXISTS ${table}`);
      let created = false;
      for (const y of FEC_CYCLES) {
        const zip = rawPath(`fec/${y}/${f}${String(y).slice(2)}.zip`);
        if (!fs.existsSync(zip)) {
          log(`  ! 缺少 ${zip}，跳过`);
          continue;
        }
        const dir = path.join(TMP_DIR, `fec-${f}-${y}`);
        const txts = unzipTo(zip, dir).filter((p) => p.endsWith('.txt'));
        // 个人捐款新周期的压缩包可能同时含整表与按日期拆分的子表：优先整表，避免重复
        const whole = txts.filter((p) => !p.includes(`${path.sep}by_date${path.sep}`));
        const use = whole.length ? whole : txts;
        const list = `[${use.map(lit).join(',')}]`;
        const src = `read_csv(${list}, delim='|', header=false, quote='', escape='', columns=${cols}, strict_mode=false, null_padding=true, ignore_errors=true)`;
        const select = `SELECT ${y}::SMALLINT AS cycle, * FROM ${src}`;
        if (!created) {
          await conn.run(`CREATE TABLE ${table} AS ${select}`);
          created = true;
        } else await conn.run(`INSERT INTO ${table} ${select}`);
        fs.rmSync(dir, { recursive: true, force: true });
        log(`  ${table} ← ${y}（${use.length} 个文件）`);
      }
      if (created) tables[table] = await rowCount(conn, table);
    }
    // 常用视图：金额转数值、日期转 DATE
    if (await tableExists(conn, 'fec_indiv')) {
      await conn.run(`CREATE OR REPLACE VIEW fec_indiv_v AS SELECT *, TRY_CAST(TRANSACTION_AMT AS DOUBLE) AS amount,
        TRY_STRPTIME(TRANSACTION_DT, '%m%d%Y')::DATE AS tx_date FROM fec_indiv`);
      if (only.has('derived')) Object.assign(tables, await buildFecDerived(conn, log));
    }
    // 记录全部 FEC 表的行数（部分重跑时也保持完整）
    const merged: Record<string, number> = {};
    for (const t of [...FEC_FILES.map((f) => `fec_${f}`), 'fec_donors', 'fec_donor_recipients', 'fec_committees']) {
      if (await tableExists(conn, t)) merged[t] = tables[t] ?? (await rowCount(conn, t));
    }
    await setMeta(conn, 'fec', { version: `cycles ${FEC_CYCLES[0]}–${FEC_CYCLES.at(-1)}`, license: this.license, note: '全量原样镜像（用户决定）', tables: merged });
    return tables;
  },
};

// ============================================================ 美国国会（unitedstates/congress-legislators）
const congress: WarehouseSource = {
  id: 'congress',
  name: 'United States Congress Legislators（1789–今）',
  license: 'CC0 1.0',
  description: '历届国会议员、总统、副总统的任期与跨库 ID 对照（bioguide、FEC、OpenSecrets、Wikidata、Ballotpedia 等）',
  downloads: () =>
    ['legislators-current.json', 'legislators-historical.json', 'executive.json'].map((f) => ({
      url: `https://unitedstates.github.io/congress-legislators/${f}`,
      file: `congress/${f}`,
    })),
  async ingest(conn) {
    const j = (f: string) => `read_json(${lit(rawPath(`congress/${f}`))}, format='array', maximum_object_size=67108864, union_by_name=true)`;
    await conn.run(`CREATE OR REPLACE TABLE us_legislators AS
      SELECT id, name, bio, terms, family, 'current' AS status FROM ${j('legislators-current.json')}
      UNION ALL BY NAME SELECT id, name, bio, terms, family, 'historical' AS status FROM ${j('legislators-historical.json')}`);
    await conn.run(`CREATE OR REPLACE TABLE us_executive AS SELECT * FROM ${j('executive.json')}`);
    const tables = { us_legislators: await rowCount(conn, 'us_legislators'), us_executive: await rowCount(conn, 'us_executive') };
    await setMeta(conn, 'congress', { license: this.license, tables });
    return tables;
  },
};

// ============================================================ 联邦司法中心（FJC）法官传记目录
const fjc: WarehouseSource = {
  id: 'fjc',
  name: 'FJC Biographical Directory of Article III Federal Judges',
  license: '美国政府公共领域',
  description: '1789 年以来全部 Article III 联邦法官（最高法院、上诉法院、地区法院、国际贸易法院），每晚更新',
  downloads: () =>
    ['judges', 'demographics', 'federal-judicial-service', 'other-federal-judicial-service', 'education', 'professional-career'].map((f) => ({
      url: `https://www.fjc.gov/sites/default/files/history/${f}.csv`,
      file: `fjc/${f}.csv`,
    })),
  async ingest(conn) {
    const c = (f: string) => `read_csv(${lit(rawPath(`fjc/${f}.csv`))}, header=true, all_varchar=true, normalize_names=true)`;
    await conn.run(`CREATE OR REPLACE TABLE fjc_judges AS SELECT * FROM ${c('judges')}`);
    await conn.run(`CREATE OR REPLACE TABLE fjc_service AS SELECT * FROM ${c('federal-judicial-service')}`);
    await conn.run(`CREATE OR REPLACE TABLE fjc_education AS SELECT * FROM ${c('education')}`);
    await conn.run(`CREATE OR REPLACE TABLE fjc_career AS SELECT * FROM ${c('professional-career')}`);
    const tables: Record<string, number> = {};
    for (const t of ['fjc_judges', 'fjc_service', 'fjc_education', 'fjc_career']) tables[t] = await rowCount(conn, t);
    await setMeta(conn, 'fjc', { license: this.license, tables });
    return tables;
  },
};

// ============================================================ LittleSis（需用户手动下载）
const littlesis: WarehouseSource = {
  id: 'littlesis',
  name: 'LittleSis 全库',
  license: 'CC BY-SA 4.0（衍生数据须同样共享）',
  description: '美国政商精英“谁认识谁”：人物、机构、关系（职务、董事、捐款、游说、家族等）',
  downloads: () => [],
  manual: {
    dir: path.join(INBOX_DIR, 'littlesis'),
    files: ['entities.json.gz', 'relationships.json.gz'],
    howto: '用浏览器打开 https://littlesis.org/database/bulk_data ，下载页面上的批量文件，原样（不解压）放入该目录',
  },
  async ingest(conn, log) {
    const dir = path.join(INBOX_DIR, 'littlesis');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(json|jsonl|ndjson)(\.gz)?$/.test(f)) : [];
    const pick = (re: RegExp) => files.find((f) => re.test(f));
    const ent = pick(/entit/i), rel = pick(/relation/i);
    if (!ent || !rel) throw new Error(`LittleSis 文件未就绪：请把 entities / relationships 批量文件放入 ${dir}（${this.manual!.howto}）`);
    log(`读取 ${ent}、${rel} …`);
    // 批量文件是 JSON:API 风格的数组：{type, id, attributes:{…}, links/self…}；展开为带类型的列
    const rj = (f: string, cols: string) => `read_json(${lit(path.join(dir, f))}, format='array', maximum_object_size=268435456, columns={${cols}})`;
    const list = (x: string) => `from_json(${x}, '["VARCHAR"]')`;
    await conn.run(`CREATE OR REPLACE TABLE ls_entities AS
      SELECT id, a->>'name' AS name, a->>'blurb' AS blurb, a->>'summary' AS summary, a->>'website' AS website,
             TRY_CAST(a->>'parent_id' AS BIGINT) AS parent_id, a->>'primary_ext' AS primary_ext,
             a->>'start_date' AS start_date, a->>'end_date' AS end_date, a->>'qid' AS qid,
             ${list("a->'aliases'")} AS aliases, ${list("a->'types'")} AS types, ${list("a->'tags'")} AS tags,
             a->'extensions' AS extensions, a->>'updated_at' AS updated_at, links->>'self' AS url
      FROM (SELECT id, attributes AS a, links FROM ${rj(ent, "type:'VARCHAR', id:'BIGINT', attributes:'JSON', links:'JSON'")})`);
    await conn.run(`CREATE OR REPLACE TABLE ls_relationships AS
      SELECT id, TRY_CAST(a->>'entity1_id' AS BIGINT) AS entity1_id, TRY_CAST(a->>'entity2_id' AS BIGINT) AS entity2_id,
             TRY_CAST(a->>'category_id' AS INTEGER) AS category_id, a->>'description1' AS description1, a->>'description2' AS description2,
             TRY_CAST(a->>'amount' AS DOUBLE) AS amount, a->>'currency' AS currency, a->>'goods' AS goods,
             a->>'start_date' AS start_date, a->>'end_date' AS end_date, TRY_CAST(a->>'is_current' AS BOOLEAN) AS is_current,
             a->>'description' AS description, a->'category_attributes' AS category_attributes, a->>'updated_at' AS updated_at, self AS url
      FROM (SELECT id, attributes AS a, self FROM ${rj(rel, "type:'VARCHAR', id:'BIGINT', attributes:'JSON', self:'VARCHAR'")})`);
    await conn.run(`CREATE INDEX IF NOT EXISTS ls_rel_e1 ON ls_relationships(entity1_id)`);
    await conn.run(`CREATE INDEX IF NOT EXISTS ls_rel_e2 ON ls_relationships(entity2_id)`);
    const tables = { ls_entities: await rowCount(conn, 'ls_entities'), ls_relationships: await rowCount(conn, 'ls_relationships') };
    const ver = (await all<{ v: string }>(conn, `SELECT max(updated_at) AS v FROM ls_entities`))[0]?.v?.slice(0, 10) ?? '';
    await setMeta(conn, 'littlesis', { version: ver, license: this.license, tables });
    return tables;
  },
};

/**
 * FEC 派生表（审核与投影用，约 2.8 亿行明细 → 捐款人汇总）：
 *   fec_donors            捐款人（姓名归一 + 州 作为键）：总额、笔数、周期、单周期最高额、常见雇主/职业
 *   fec_donor_recipients  捐款人 × 接收委员会：金额汇总（只含累计 ≥ 1 万美元的捐款人）
 *   fec_committees        委员会最新信息
 * 只统计个人（ENTITY_TP=IND）、正数金额、非备忘行（MEMO_CD≠X，避免重复计算）。键中的州只用于区分同名者，不进入图谱。
 *
 * 内存安全：逐周期聚合到中间表（每次只扫一个周期），只用 sum/count/min/max/any_value 这类可溢写到磁盘的聚合；
 * 雇主/职业只对大额捐款人计算（先按 (捐款人, 雇主, 职业) 计数再取前 3）。不要在全表上用 approx_top_k / list 等
 * 按组持有大状态的聚合——它们无法溢写，曾导致整机内存耗尽。
 */
export const FEC_DONOR_KEY = `regexp_replace(regexp_replace(upper(trim(NAME)), '[^A-Z, ]', '', 'g'), '\\s+', ' ', 'g') || '|' || coalesce(STATE, '')`;
const FEC_IND = `ENTITY_TP = 'IND' AND (MEMO_CD IS NULL OR MEMO_CD <> 'X')`;
export async function buildFecDerived(conn: DuckDBConnection, log: (m: string) => void) {
  const cycles = (await all<{ c: number }>(conn, `SELECT DISTINCT cycle AS c FROM fec_indiv ORDER BY 1`)).map((r) => Number(r.c));
  log(`  派生表 1/4：逐周期汇总（捐款人 × 委员会 × 周期），共 ${cycles.length} 个周期 …`);
  await conn.run(`DROP TABLE IF EXISTS fec_dc`);
  await conn.run(`CREATE TABLE fec_dc (donor_key VARCHAR, cycle SMALLINT, cmte_id VARCHAR, name VARCHAR, state VARCHAR, total DOUBLE, n BIGINT)`);
  for (const y of cycles) {
    await conn.run(`INSERT INTO fec_dc
      SELECT donor_key, ${y}, CMTE_ID, any_value(NAME), any_value(STATE), sum(amount), count(*)
      FROM (SELECT ${FEC_DONOR_KEY} AS donor_key, CMTE_ID, NAME, STATE, TRY_CAST(TRANSACTION_AMT AS DOUBLE) AS amount
            FROM fec_indiv WHERE cycle = ${y} AND ${FEC_IND})
      WHERE amount > 0 GROUP BY donor_key, CMTE_ID`);
    log(`    周期 ${y} ✓`);
  }
  log('  派生表 2/4：fec_donors …');
  await conn.run(`CREATE OR REPLACE TABLE fec_donors AS
    WITH pc AS (SELECT donor_key, cycle, any_value(name) AS name, any_value(state) AS state, sum(total) AS total, sum(n) AS n FROM fec_dc GROUP BY donor_key, cycle)
    SELECT donor_key, any_value(name) AS name, any_value(state) AS state, sum(total) AS total, sum(n)::BIGINT AS n,
           min(cycle) AS c0, max(cycle) AS c1, max(total) AS max_cycle_total,
           NULL::VARCHAR[] AS employers, NULL::VARCHAR[] AS occupations
    FROM pc GROUP BY donor_key`);
  log('  派生表 3/4：大额捐款人（累计 ≥ 1 万美元）的常见雇主/职业 …');
  await conn.run(`CREATE OR REPLACE TEMP TABLE big_donors AS SELECT donor_key FROM fec_donors WHERE total >= 10000`);
  await conn.run(`DROP TABLE IF EXISTS fec_de`);
  await conn.run(`CREATE TABLE fec_de (donor_key VARCHAR, employer VARCHAR, occupation VARCHAR, n BIGINT)`);
  for (const y of cycles) {
    await conn.run(`INSERT INTO fec_de
      SELECT k.donor_key, k.EMPLOYER, k.OCCUPATION, count(*)
      FROM (SELECT ${FEC_DONOR_KEY} AS donor_key, EMPLOYER, OCCUPATION FROM fec_indiv WHERE cycle = ${y} AND ${FEC_IND}) k
      SEMI JOIN big_donors b ON b.donor_key = k.donor_key
      GROUP BY ALL`);
  }
  await conn.run(`CREATE OR REPLACE TEMP TABLE de_top AS
    WITH e AS (SELECT donor_key, employer, sum(n) AS n FROM fec_de WHERE employer IS NOT NULL AND employer <> '' GROUP BY 1, 2),
         o AS (SELECT donor_key, occupation, sum(n) AS n FROM fec_de WHERE occupation IS NOT NULL AND occupation <> '' GROUP BY 1, 2),
         er AS (SELECT donor_key, employer, row_number() OVER (PARTITION BY donor_key ORDER BY n DESC) AS rk FROM e),
         orr AS (SELECT donor_key, occupation, row_number() OVER (PARTITION BY donor_key ORDER BY n DESC) AS rk FROM o)
    SELECT coalesce(a.donor_key, b.donor_key) AS donor_key, a.employers, b.occupations
    FROM (SELECT donor_key, list(employer ORDER BY rk) AS employers FROM er WHERE rk <= 3 GROUP BY 1) a
    FULL JOIN (SELECT donor_key, list(occupation ORDER BY rk) AS occupations FROM orr WHERE rk <= 3 GROUP BY 1) b USING (donor_key)`);
  await conn.run(`UPDATE fec_donors SET employers = t.employers, occupations = t.occupations FROM de_top t WHERE fec_donors.donor_key = t.donor_key`);
  log('  派生表 4/4：fec_donor_recipients、fec_committees …');
  await conn.run(`CREATE OR REPLACE TABLE fec_donor_recipients AS
    SELECT d.donor_key, d.cmte_id, sum(d.total) AS total, sum(d.n)::BIGINT AS n, min(d.cycle) AS c0, max(d.cycle) AS c1
    FROM fec_dc d SEMI JOIN big_donors b ON b.donor_key = d.donor_key
    GROUP BY d.donor_key, d.cmte_id`);
  await conn.run(`CREATE OR REPLACE TABLE fec_committees AS
    SELECT * EXCLUDE (rn) FROM (SELECT *, row_number() OVER (PARTITION BY CMTE_ID ORDER BY cycle DESC) AS rn FROM fec_cm) WHERE rn = 1`);
  // 中间表体量大且可再生，用完即删
  await conn.run(`DROP TABLE IF EXISTS fec_dc`);
  await conn.run(`DROP TABLE IF EXISTS fec_de`);
  return {
    fec_donors: await rowCount(conn, 'fec_donors'),
    fec_donor_recipients: await rowCount(conn, 'fec_donor_recipients'),
    fec_committees: await rowCount(conn, 'fec_committees'),
  };
}

export const SOURCES: Record<string, WarehouseSource> = { opensanctions, icij, fec, congress, fjc, littlesis };
