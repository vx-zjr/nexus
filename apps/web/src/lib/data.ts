import type { GraphData } from '@nexus/core';
import { useNexus } from '../store/useNexus';
import { api, fetchCore, probe, resetPatches } from './api';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let retry: ReturnType<typeof setInterval> | undefined;

/**
 * 加载图谱：优先从本地 API（ctos serve）取核心子图并订阅重编译事件；API 不可用时读静态 graph.json。
 */
export async function loadGraph() {
  try {
    let data: GraphData;
    let st = await probe();
    // API 刚启动、正在首次编译：等它（最多约 2 分钟）
    for (let i = 0; st === 'building' && i < 120; i++) {
      await sleep(1000);
      st = await probe();
    }
    if (st === 'online') {
      data = await fetchCore();
      if (retry) clearInterval(retry);
      retry = undefined;
    } else {
      // 静态模式：之后每 10 秒探测一次，API 上线后自动切换到完整模式
      retry ??= setInterval(() => {
        void probe().then((s) => {
          if (s === 'online') void loadGraph();
        });
      }, 10000);
      const res = await fetch(`${import.meta.env.BASE_URL}data/graph.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}：找不到 data/graph.json，请先运行 npm run ctos -- build（或 npm run ctos -- serve 启动本地 API）`);
      data = (await res.json()) as GraphData;
    }
    resetPatches();
    useNexus.getState().setData(data, api.online);
    subscribe();
  } catch (e) {
    useNexus.getState().setError((e as Error).message);
  }
}

let es: EventSource | undefined;
/** 订阅 API 的数据更新事件：data/ 下任何改动（人或 AI）→ 服务端重编译 → 前端重载 */
function subscribe() {
  if (!api.online || es) return;
  es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as { type: string; version: number };
    if (msg.type === 'data' && msg.version !== api.version) void loadGraph();
  };
  es.onerror = () => {
    // 服务重启时 EventSource 会自动重连；连续失败则关闭，回到静态模式
    if (es?.readyState === EventSource.CLOSED) es = undefined;
  };
}

if (import.meta.hot) {
  import.meta.hot.on('nexus:data', () => {
    void loadGraph();
  });
}
