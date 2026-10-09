#!/usr/bin/env node

/**
 * 空闲基线测量（D1，2026-10-05 用户确认的发布门槛工具）：
 * 对本机正在运行的 DeepAA 进程（Web :3210 / 代理 :3211）做周期采样，输出
 * 平均/峰值 CPU（单核百分比）与 RSS，并按发布门槛给出判定：
 *   - 空闲 CPU 均值 ≤ 2% 单核（目标 1–2%，来自 2026-10-05 批次 1 方案）
 *   - 单进程 RSS ≤ 512 MiB
 *
 * 仅只读采样（ps / lsof），不触碰任何进程。使用前提：测量窗口内无同步/回补/请求
 * 流量（空闲基线的定义）；本机 macOS 与 Windows（进程探测命令不同，当前仅实现
 * macOS，Windows 待真实验收环境补齐——与 AGENTS 的 Windows 验收红线一致）。
 *
 * 用法：node scripts/measure-idle-baseline.mjs [--duration 600] [--interval 5]
 */

import {execFileSync} from "node:child_process";

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const durationSec = flagValue("--duration", 600);
const intervalSec = flagValue("--interval", 5);
const CPU_THRESHOLD = 2;
const RSS_THRESHOLD_MIB = 512;

function findProcesses() {
  // 只读：lsof 定位端口持有者（与生产诊断同手段），ps 取命令行佐证角色。
  const findPortPid = (port) => {
    try {
      const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {encoding: "utf8"});
      const pid = out.trim().split("\n")[0];
      return pid ? Number(pid) : undefined;
    } catch {
      return undefined;
    }
  };
  const roles = [
    {name: "web(:3210)", pid: findPortPid(3210)},
    {name: "proxy(:3211)", pid: findPortPid(3211)},
  ].filter(role => role.pid !== undefined);
  if (roles.length === 0) {
    console.error("未发现监听 3210/3211 的进程——请先启动 DeepAA 再测量。");
    process.exitCode = 1;
    return null;
  }
  for (const role of roles) {
    try {
      role.command = execFileSync("ps", ["-p", String(role.pid), "-o", "command="], {encoding: "utf8"}).trim();
    } catch {
      role.command = "<已退出>";
    }
  }
  return roles;
}

function sample(pids) {
  const rows = execFileSync(
    "ps", ["-p", pids.join(","), "-o", "pid=,%cpu=,rss="],
    {encoding: "utf8"},
  ).trim().split("\n").map(line => {
    const [pid, cpu, rssKb] = line.trim().split(/\s+/);
    return {pid: Number(pid), cpu: Number(cpu), rssMiB: Number(rssKb) / 1024};
  });
  return new Map(rows.map(row => [row.pid, row]));
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("当前仅实现 macOS 采样；Windows 版本需在真实 Windows 环境验收后启用（AGENTS 红线）。");
    process.exitCode = 1;
    return;
  }
  const roles = findProcesses();
  if (!roles) return;
  console.log(`空闲基线测量：${durationSec}s / 每 ${intervalSec}s 一采样`);
  for (const role of roles) console.log(`  ${role.name} → PID ${role.pid}（${role.command.slice(0, 80)}）`);
  console.log("前提：窗口内无请求流量、同步与回补（空闲定义）。开始采样...\n");

  // ps 的 %CPU 是近一分钟的衰减均值：首轮样本丢弃，让窗口边界干净。
  const samples = new Map(roles.map(role => [role.pid, []]));
  const rounds = Math.max(2, Math.round(durationSec / intervalSec));
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setTimeout(resolve, intervalSec * 1000));
    const snapshot = sample(roles.map(role => role.pid));
    for (const role of roles) {
      const row = snapshot.get(role.pid);
      if (row && round > 0) samples.get(role.pid).push(row);
    }
  }

  let allPass = true;
  console.log("=== 结果（发布门槛：空闲 CPU 均值 ≤ 2% 单核；RSS ≤ 512MiB/进程）===");
  for (const role of roles) {
    const list = samples.get(role.pid);
    if (list.length === 0) {
      console.log(`  ${role.name}：采样期间进程退出，无有效样本`);
      allPass = false;
      continue;
    }
    const cpuAvg = list.reduce((sum, row) => sum + row.cpu, 0) / list.length;
    const cpuMax = Math.max(...list.map(row => row.cpu));
    const rssMax = Math.max(...list.map(row => row.rssMiB));
    const pass = cpuAvg <= CPU_THRESHOLD && rssMax <= RSS_THRESHOLD_MIB;
    if (!pass) allPass = false;
    console.log(
      `  ${role.name}：CPU 均值 ${cpuAvg.toFixed(2)}% / 峰值 ${cpuMax.toFixed(1)}%`
      + `，RSS 峰值 ${rssMax.toFixed(0)}MiB → ${pass ? "PASS" : "FAIL"}（样本 ${list.length}）`,
    );
  }
  console.log(allPass ? "\n总体判定：PASS（达到发布门槛）" : "\n总体判定：FAIL（未达门槛——先排查流量残留/追赶期，再按 D2/D3 治理项归因）");
  if (!allPass) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
