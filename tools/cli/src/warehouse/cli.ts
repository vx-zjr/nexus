/**
 * ctos warehouse <子命令>
 *   status                     各来源：原始文件是否就绪、入库版本与行数
 *   fetch [source…]            断点续传下载原始文件（默认全部可自动下载的来源）
 *   ingest <source…|all> [--only indiv,pas2]   入库（FEC 可用 --only 只导部分文件）
 *   search <关键词> [--source os|icij|fec|congress|fjc|littlesis] [--limit N]
 *   sql "<SQL>" [--json] [--limit N]   直接查询（只读）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SOURCES } from './sources.ts';
import { DB_PATH, RAW_DIR, all, openWarehouse, tableExists } from './db.ts';

const UA = process.env.NEXUS_USER_AGENT ?? 'NEXUS-relationship-intel/0.1 (personal research)';

function fmtBytes(n: number) {
  return n > 1e9 ? `${(n / 1e9).toFixed(2)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${(n / 1e3).toFixed(0)}KB`;
}

interface Head {
  size?: number;
  etag?: string;
  lastModified?: string;
}
/** HEAD（跟随重定向，取最后一跳的响应头） */
function head(url: string): Head {
  const r = spawnSync('curl', ['-sIL', '-A', UA, '--max-time', '60', url], { encoding: 'utf8' });
  const blocks = (r.stdout ?? '').split(/\r?\n\r?\n/).filter((b) => b.trim());
  const last = blocks.at(-1) ?? '';
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'im').exec(last)?.[1]?.trim();
  const size = Number(get('content-length'));
  return { size: Number.isFinite(size) && size > 0 ? size : undefined, etag: get('etag'), lastModified: get('last-modified') };
}

const zipOk = (file: string) => !file.endsWith('.zip') || spawnSync('unzip', ['-tqq', file], { stdio: 'ignore' }).status === 0;

/**
 * 稳健下载：记录远端 ETag/Last-Modified（<file>.dl.json）。
 * 远端未变 → 断点续传；远端已更新（OpenSanctions 每日、FEC 每周重新发布）或本地损坏 → 整份重下；
 * 完成后校验大小与 zip 完整性。已是最新则跳过。
 */
function download(url: string, out: string, log: (m: string) => void): boolean {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const metaFile = `${out}.dl.json`;
  for (let i = 0; i < 6; i++) {
    const h = head(url);
    let meta: Head = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Head;
    } catch {
      /* 无记录 */
    }
    const local = fs.existsSync(out) ? fs.statSync(out).size : 0;
    const same = (!meta.etag || !h.etag || meta.etag === h.etag) && (!meta.lastModified || !h.lastModified || meta.lastModified === h.lastModified);
    if (h.size && local === h.size && same && zipOk(out)) {
      if (i === 0) log('  已是最新');
      fs.writeFileSync(metaFile, JSON.stringify(h));
      return true;
    }
    if (local && (!same || (h.size && local >= h.size) || (h.size && local === h.size && !zipOk(out)))) {
      log(`  远端已更新或本地文件不完整，整份重下`);
      fs.rmSync(out, { force: true });
    }
    fs.writeFileSync(metaFile, JSON.stringify(h));
    const r = spawnSync('curl', ['-sSL', '--fail', '-A', UA, '-C', '-', '--retry', '5', '--retry-delay', '10', '-o', out, url], { stdio: 'inherit' });
    const got = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (r.status === 0 && (!h.size || got === h.size) && zipOk(out)) return true;
    log(`  … 未完成（${got}/${h.size ?? '?'} 字节，第 ${i + 1} 次），稍后重试：${url}`);
    spawnSync('sleep', ['15']);
  }
  return false;
}

export async function runWarehouse(argv: string[], log: (m: string) => void) {
  const [sub, ...rest] = argv;
  const flag = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

  switch (sub) {
    case 'status': {
      let meta: Record<string, { version: string; ingested_at: string; tables: string }> = {};
      if (fs.existsSync(DB_PATH)) {
        const wh = await openWarehouse({ readOnly: true });
        try {
          if (await tableExists(wh.conn, 'wh_sources')) {
            for (const r of await all<{ source: string; version: string; ingested_at: string; tables: string }>(wh.conn, 'SELECT * FROM wh_sources')) meta[r.source] = r;
          }
        } finally {
          wh.close();
        }
      }
      for (const s of Object.values(SOURCES)) {
        const files = s.downloads();
        const have = files.filter((f) => fs.existsSync(path.join(RAW_DIR, f.file)));
        const size = have.reduce((n, f) => n + fs.statSync(path.join(RAW_DIR, f.file)).size, 0);
        const m = meta[s.id];
        const manual = s.manual ? (fs.existsSync(s.manual.dir) ? fs.readdirSync(s.manual.dir).length : 0) : null;
        log(`${s.id.padEnd(14)} 原始文件 ${s.manual ? `手动 ${manual} 个` : `${have.length}/${files.length}`} ${fmtBytes(size).padStart(8)}  ` +
          (m ? `已入库 ${m.ingested_at?.slice(0, 16)} 版本 ${m.version || '-'} ${Object.entries(JSON.parse(m.tables)).map(([k, v]) => `${k}=${Number(v).toLocaleString()}`).join(' ')}` : '未入库'));
      }
      if (fs.existsSync(DB_PATH)) log(`数据库 ${DB_PATH} ${fmtBytes(fs.statSync(DB_PATH).size)}`);
      return;
    }
    case 'fetch': {
      const ids = positional.length ? positional : Object.keys(SOURCES);
      for (const id of ids) {
        const s = SOURCES[id];
        if (!s) throw new Error(`未知来源 ${id}`);
        if (s.manual) {
          log(`${id}: 需手动下载 —— ${s.manual.howto}\n  放入：${s.manual.dir}`);
          fs.mkdirSync(s.manual.dir, { recursive: true });
          continue;
        }
        for (const f of s.downloads()) {
          const out = path.join(RAW_DIR, f.file);
          log(`${id}: ${f.url}`);
          if (!download(f.url, out, log) && !f.optional) log(`  ! 失败：${f.url}`);
        }
      }
      return;
    }
    case 'ingest': {
      const ids = positional[0] === 'all' ? Object.keys(SOURCES).filter((k) => !SOURCES[k].manual) : positional;
      if (!ids.length) throw new Error(`用法：ctos warehouse ingest <${Object.keys(SOURCES).join('|')}|all>`);
      const wh = await openWarehouse();
      try {
        for (const id of ids) {
          const s = SOURCES[id];
          if (!s) throw new Error(`未知来源 ${id}`);
          const t = Date.now();
          log(`== 入库 ${s.name}`);
          const tables = await s.ingest(wh.conn, log, { only: flag('--only')?.split(',') });
          log(`   完成（${((Date.now() - t) / 1000).toFixed(0)}s）：${Object.entries(tables).map(([k, v]) => `${k}=${v.toLocaleString()}`).join(' ')}`);
        }
        await wh.conn.run('CHECKPOINT');
      } finally {
        wh.close();
      }
      return;
    }
    case 'search': {
      const q = positional.join(' ').trim();
      if (!q) throw new Error('用法：ctos warehouse search <关键词>');
      const { searchWarehouse } = await import('./search.ts');
      const wh = await openWarehouse({ readOnly: true });
      try {
        const rows = await searchWarehouse(wh.conn, q, { source: flag('--source'), limit: Number(flag('--limit') ?? 30) });
        for (const r of rows) log(`${r.source.padEnd(13)} ${String(r.id).padEnd(28)} ${r.kind.padEnd(12)} ${r.name}  \x1b[2m${r.detail ?? ''}\x1b[0m`);
        if (!rows.length) log('无结果');
      } finally {
        wh.close();
      }
      return;
    }
    case 'sql': {
      const wh = await openWarehouse({ readOnly: true });
      try {
        const rows = (await all(wh.conn, positional.join(' '))).slice(0, Number(flag('--limit') ?? 50));
        if (rest.includes('--json')) for (const r of rows) console.log(JSON.stringify(r));
        else console.table(rows);
      } finally {
        wh.close();
      }
      return;
    }
    default:
      log(`用法：ctos warehouse <status|fetch|ingest|search|sql>\n来源：${Object.values(SOURCES).map((s) => `${s.id}（${s.license}）`).join('；')}`);
  }
}
