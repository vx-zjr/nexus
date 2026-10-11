import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const GRAPH = path.join(import.meta.dirname, 'public/data/graph.json');

const API_PORT = Number(process.env.NEXUS_API_PORT ?? 5318);

/**
 * 本地 API（ctos serve）：开发服务器启动时若 API 未在运行，则作为子进程拉起；Vite 退出时一并结束。
 * API 进程在内存中持有完整图谱，监听 data/ 变动自动重编译，并通过 SSE 通知前端刷新。
 * 设置 NEXUS_NO_API=1 可只用静态 graph.json（此时 data/ 改动后由本插件调用 ctos build 重编译）。
 */
function nexusApi(): Plugin {
  let child: ChildProcess | undefined;
  const alive = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health`, { signal: AbortSignal.timeout(800) });
      return r.ok;
    } catch {
      return false;
    }
  };
  return {
    name: 'nexus-api',
    async configureServer(server: ViteDevServer) {
      const log = (m: string) => server.config.logger.info(m.replace(/\x1b\[\d+m/g, ''), { timestamp: true });
      if (process.env.NEXUS_NO_API) return staticRebuild(server);
      if (await alive()) {
        log(`[nexus] 复用已在运行的本地 API :${API_PORT}`);
        return;
      }
      child = spawn('npx', ['tsx', 'tools/cli/src/main.ts', 'serve', '--port', String(API_PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const pipe = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log);
      child.stdout?.on('data', pipe);
      child.stderr?.on('data', pipe);
      child.on('exit', (code) => log(`[nexus] 本地 API 已退出（${code}）`));
      const kill = () => child?.kill();
      process.once('exit', kill);
      server.httpServer?.once('close', kill);
    },
  };
}

/** 无 API 模式：监听 data/，改动后子进程运行 ctos build，再通知前端重载 graph.json */
function staticRebuild(server: ViteDevServer) {
  let building = false;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  const build = () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    const t = Date.now();
    const p = spawn('npx', ['tsx', 'tools/cli/src/main.ts', 'build'], { cwd: ROOT, stdio: 'ignore' });
    p.on('close', (code) => {
      building = false;
      server.config.logger.info(`[nexus] 数据已编译 (${((Date.now() - t) / 1000).toFixed(1)}s)`, { timestamp: true });
      if (code === 0) server.ws.send({ type: 'custom', event: 'nexus:data', data: { at: Date.now() } });
      if (pending) {
        pending = false;
        build();
      }
    });
  };
  if (!fs.existsSync(GRAPH)) build();
  server.watcher.add(DATA_DIR);
  const onChange = (file: string) => {
    if (!file.startsWith(DATA_DIR) || file.includes(`${path.sep}warehouse${path.sep}`) || !/\.(ya?ml|json)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(build, 400);
  };
  server.watcher.on('change', onChange);
  server.watcher.on('add', onChange);
  server.watcher.on('unlink', onChange);
}

export default defineConfig({
  plugins: [react(), tailwindcss(), nexusApi()],
  server: {
    port: 5317,
    host: '127.0.0.1',
    // data/warehouse 是数十 GB 的原始仓库，不需要监听
    watch: { ignored: ['**/public/data/**', '**/data/warehouse/**'] },
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
