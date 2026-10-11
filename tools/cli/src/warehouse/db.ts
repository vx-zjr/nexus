/**
 * 原始数据仓库（DuckDB）：官方公开数据集的本地全量镜像。
 *
 *   data/warehouse/raw/<source>/   下载的原始文件（可重建）
 *   data/warehouse/nexus.duckdb    统一的分析库（每个来源一组表，表名带来源前缀）
 *
 * 与知识图谱（data/ 下的 YAML/JSON 各层）的关系：仓库是“原样镜像 + 检索”，图谱只收录经筛选/匹配的子集。
 * DuckDB 同一时刻只允许一个读写进程：写入（ingest）时请先停掉 API 服务，或让服务以只读方式短连接访问。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { DATA_DIR } from '../lib.ts';
import { duckdbLimits } from '../guard.ts';

export const WAREHOUSE_DIR = path.join(DATA_DIR, 'warehouse');
export const RAW_DIR = path.join(WAREHOUSE_DIR, 'raw');
export const INBOX_DIR = path.join(WAREHOUSE_DIR, 'inbox');
export const DB_PATH = path.join(WAREHOUSE_DIR, 'nexus.duckdb');
export const TMP_DIR = path.join(WAREHOUSE_DIR, 'tmp');

export interface Warehouse {
  conn: DuckDBConnection;
  close(): void;
}

export async function openWarehouse(opts: { readOnly?: boolean; threads?: number; memory?: string } = {}): Promise<Warehouse> {
  fs.mkdirSync(WAREHOUSE_DIR, { recursive: true });
  if (opts.readOnly && !fs.existsSync(DB_PATH)) throw new Error(`仓库尚未建立：${DB_PATH}（先运行 ctos warehouse ingest <source>）`);
  // 内存/线程默认按本机配置计算（见 guard.ts）；超出内存的中间结果溢写到 temp_directory
  const lim = duckdbLimits();
  const config: Record<string, string> = {
    threads: String(opts.threads ?? lim.threads),
    memory_limit: opts.memory ?? lim.memory,
    temp_directory: TMP_DIR,
    max_temp_directory_size: '300GB',
    preserve_insertion_order: 'false',
  };
  if (opts.readOnly) config.access_mode = 'READ_ONLY';
  const inst = await DuckDBInstance.create(DB_PATH, config);
  const conn = await inst.connect();
  return {
    conn,
    close() {
      conn.closeSync();
      inst.closeSync();
    },
  };
}

/** 运行 SQL 并以 JSON 友好的对象数组返回（BIGINT 等会转成字符串/数字） */
export async function all<T = Record<string, unknown>>(conn: DuckDBConnection, sql: string, params?: DuckDBValue[] | Record<string, DuckDBValue>): Promise<T[]> {
  const r = await conn.runAndReadAll(sql, params);
  return r.getRowObjectsJson() as unknown as T[];
}

export async function tableExists(conn: DuckDBConnection, name: string): Promise<boolean> {
  const r = await all<{ n: number }>(conn, `SELECT count(*)::INT AS n FROM information_schema.tables WHERE table_name = $1`, [name]);
  return Number(r[0]?.n ?? 0) > 0;
}

export async function rowCount(conn: DuckDBConnection, table: string): Promise<number> {
  const r = await all<{ n: string | number }>(conn, `SELECT count(*) AS n FROM ${table}`);
  return Number(r[0]?.n ?? 0);
}

/** SQL 字符串字面量转义 */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 记录每个来源的导入元数据（版本、时间、行数），供 status 与 UI 展示 */
export async function ensureMeta(conn: DuckDBConnection) {
  await conn.run(`CREATE TABLE IF NOT EXISTS wh_sources (source VARCHAR PRIMARY KEY, version VARCHAR, ingested_at TIMESTAMP, license VARCHAR, note VARCHAR, tables JSON)`);
}

export async function setMeta(conn: DuckDBConnection, source: string, meta: { version?: string; license: string; note?: string; tables: Record<string, number> }) {
  await ensureMeta(conn);
  await conn.run(`DELETE FROM wh_sources WHERE source = $1`, [source]);
  await conn.run(`INSERT INTO wh_sources VALUES ($1, $2, now(), $3, $4, $5)`, [source, meta.version ?? '', meta.license, meta.note ?? '', JSON.stringify(meta.tables)]);
}

export function rawPath(...p: string[]) {
  return path.join(RAW_DIR, ...p);
}
