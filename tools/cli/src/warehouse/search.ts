/**
 * 仓库统一检索：在各来源的原始表中按名字查找记录（不区分大小写的子串匹配）。
 * FEC 个人捐款明细（约 2.7 亿行）默认不参与，需显式 source=fec-indiv。
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import { all, tableExists } from './db.ts';

export interface WarehouseHit {
  source: string;
  id: string;
  kind: string;
  name: string;
  detail?: string;
}

const QUERIES: Record<string, { table: string; sql: (limit: number) => string }> = {
  opensanctions: {
    table: 'os_entities',
    sql: (n) => `SELECT 'opensanctions' AS source, id, schema AS kind, caption AS name,
        array_to_string(countries, ',') || ' · ' || array_to_string(topics, ',') AS detail
      FROM os_entities WHERE search LIKE '%' || lower($1) || '%' AND schema IN ('Person','Company','Organization','PublicBody','LegalEntity','Position')
      ORDER BY target DESC, length(caption) LIMIT ${n}`,
  },
  icij: {
    table: 'icij_entities',
    sql: (n) => `SELECT 'icij' AS source, node_id AS id, kind, name, coalesce(countries, '') || ' · ' || coalesce(sourceID, '') AS detail
      FROM icij_nodes WHERE lower(name) LIKE '%' || lower($1) || '%' LIMIT ${n}`,
  },
  congress: {
    table: 'us_legislators',
    sql: (n) => `SELECT 'congress' AS source, id.bioguide AS id, 'legislator' AS kind,
        coalesce(name.official_full, name.first || ' ' || name.last) AS name, status || ' · ' || len(terms) || ' terms' AS detail
      FROM us_legislators WHERE lower(coalesce(name.official_full, name.first || ' ' || name.last)) LIKE '%' || lower($1) || '%' LIMIT ${n}`,
  },
  fjc: {
    table: 'fjc_judges',
    sql: (n) => `SELECT 'fjc' AS source, nid AS id, 'judge' AS kind, first_name || ' ' || last_name AS name, court_name_1 AS detail
      FROM fjc_judges WHERE lower(first_name || ' ' || last_name) LIKE '%' || lower($1) || '%' LIMIT ${n}`,
  },
  fec: {
    table: 'fec_cm',
    sql: (n) => `(SELECT DISTINCT 'fec' AS source, CMTE_ID AS id, 'committee' AS kind, CMTE_NM AS name, CMTE_TP || ' · ' || coalesce(CONNECTED_ORG_NM, '') AS detail
        FROM fec_cm WHERE lower(CMTE_NM) LIKE '%' || lower($1) || '%' LIMIT ${n})
      UNION ALL (SELECT DISTINCT 'fec', CAND_ID, 'candidate', CAND_NAME, CAND_OFFICE || ' ' || coalesce(CAND_OFFICE_ST, '') || ' · ' || coalesce(CAND_PTY_AFFILIATION, '')
        FROM fec_cn WHERE lower(CAND_NAME) LIKE '%' || lower($1) || '%' LIMIT ${n})`,
  },
  'fec-indiv': {
    table: 'fec_indiv',
    sql: (n) => `SELECT 'fec-indiv' AS source, NAME AS id, 'donor' AS kind, NAME AS name,
        count(*) || ' 笔 · $' || round(sum(TRY_CAST(TRANSACTION_AMT AS DOUBLE)))::BIGINT || ' · ' || string_agg(DISTINCT EMPLOYER, '/') AS detail
      FROM fec_indiv WHERE NAME LIKE '%' || upper($1) || '%' GROUP BY NAME ORDER BY sum(TRY_CAST(TRANSACTION_AMT AS DOUBLE)) DESC LIMIT ${n}`,
  },
  littlesis: {
    table: 'ls_entities',
    sql: (n) => `SELECT 'littlesis' AS source, CAST(id AS VARCHAR) AS id, 'entity' AS kind, CAST(name AS VARCHAR) AS name, CAST(blurb AS VARCHAR) AS detail
      FROM ls_entities WHERE lower(CAST(name AS VARCHAR)) LIKE '%' || lower($1) || '%' LIMIT ${n}`,
  },
};

export async function searchWarehouse(conn: DuckDBConnection, q: string, opts: { source?: string; limit?: number } = {}): Promise<WarehouseHit[]> {
  const limit = Math.min(opts.limit ?? 30, 500);
  const ids = opts.source ? [opts.source === 'os' ? 'opensanctions' : opts.source] : Object.keys(QUERIES).filter((k) => k !== 'fec-indiv');
  const out: WarehouseHit[] = [];
  for (const id of ids) {
    const def = QUERIES[id];
    if (!def || !(await tableExists(conn, def.table))) continue;
    out.push(...(await all<WarehouseHit>(conn, def.sql(limit), [q])));
  }
  return out;
}
