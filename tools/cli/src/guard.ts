/**
 * 资源护栏：防止重任务（仓库入库、派生表、候选生成、大体量投影）吃满 CPU/内存导致整机卡死。
 *
 * 背景：本机无 swap，内存耗尽时系统会陷入抖动而不是及时 OOM，表现为整机冻结（2026-10-11 构建 FEC 派生表时发生过）。
 * 做法：
 *   1. 重任务在 systemd 用户 cgroup 中重新执行：MemoryMax（硬上限，超出只杀该任务）+ MemoryHigh（先限速回收）+ 禁用 swap；
 *      CPUWeight 调低、nice/ionice 降优先级，桌面与其他程序保持流畅。
 *   2. DuckDB 的内存/线程默认值按本机配置计算（见 duckdbLimits），并留出 Node 进程与系统的余量。
 * 环境变量：NEXUS_GUARD=0 关闭护栏；NEXUS_MEM_MAX（如 24G）覆盖 cgroup 上限；NEXUS_DUCKDB_MEMORY / NEXUS_DUCKDB_THREADS 覆盖 DuckDB 设置。
 */
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const GiB = 1024 ** 3;
const totalGiB = () => os.totalmem() / GiB;

/** cgroup 内存硬上限：默认总内存的 50% */
export function memMax(): string {
  return process.env.NEXUS_MEM_MAX ?? `${Math.max(2, Math.floor(totalGiB() * 0.5))}G`;
}

/** DuckDB 默认：内存 = 总内存的 30%（低于 cgroup 上限，留给 Node 堆与页缓存），线程 = CPU 核数的一半（2–8） */
export function duckdbLimits(): { memory: string; threads: number } {
  const memory = process.env.NEXUS_DUCKDB_MEMORY ?? `${Math.max(1, Math.floor(totalGiB() * 0.3))}GB`;
  const threads = Number(process.env.NEXUS_DUCKDB_THREADS ?? Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2))));
  return { memory, threads };
}

const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

/**
 * 在受限的 cgroup 中重新执行当前命令（已在护栏内或关闭护栏时返回 false，调用方继续正常执行）。
 * 返回 true 表示已由子进程执行完毕，调用方应以 process.exitCode 退出。
 */
export function runGuarded(label: string): boolean {
  if (process.env.NEXUS_GUARDED === '1' || process.env.NEXUS_GUARD === '0') return false;
  const max = memMax();
  const high = `${Math.max(1, Math.floor(parseFloat(max) * 0.9))}G`;
  const node = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  const prio = [...(has('nice') ? ['nice', '-n', '10'] : []), ...(has('ionice') ? ['ionice', '-c', '3'] : [])];
  let cmd: string[];
  if (has('systemd-run') && spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { stdio: 'ignore' }).status === 0) {
    cmd = ['systemd-run', '--user', '--scope', '--quiet', '-p', `MemoryMax=${max}`, '-p', `MemoryHigh=${high}`, '-p', 'MemorySwapMax=0', '-p', 'CPUWeight=20', ...prio, ...node];
    console.error(`\x1b[2m[guard] ${label}：在受限 cgroup 中运行（内存上限 ${max}，低 CPU/IO 优先级；NEXUS_GUARD=0 可关闭）\x1b[0m`);
  } else {
    cmd = [...prio, ...node];
    console.error(`\x1b[2m[guard] ${label}：未找到 systemd-run，仅降低优先级运行（无内存硬上限）\x1b[0m`);
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, NEXUS_GUARDED: '1' } });
  if (r.signal === 'SIGKILL' || r.status === 137) console.error(`[guard] 任务因超过内存上限 ${max} 被终止（系统未受影响）。可调小数据批次，或设 NEXUS_MEM_MAX 提高上限。`);
  process.exitCode = r.status ?? 1;
  return true;
}
