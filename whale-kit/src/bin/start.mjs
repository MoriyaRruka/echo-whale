// 看门人：拉机器人，挂了就五秒后重拉。面板的「启动/停止/重启」也是走这里。
// 用法：node bin\start.mjs          前台（黑窗口里看得到日志）
//       node bin\start.mjs --detach 后台（面板用，日志写 logs\supervisor.log）

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './profile.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DETACH = process.argv.includes('--detach');
const RUNTIME = path.join(ROOT, 'runtime');
const LOGS = path.join(ROOT, 'logs');
const PID_FILE = path.join(RUNTIME, 'supervisor.pid');
const BOT_PID_FILE = path.join(RUNTIME, 'bot.pid');
fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const say = (s) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${s}`;
  console.log(line);
};

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// 同一个包只跑一个看门人
const old = Number((fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim()) || 0);
if (old && old !== process.pid && alive(old)) {
  say(`已经在跑了（看门人 PID ${old}），不重复启动。`);
  process.exit(0);
}

const cfg = loadConfig();
if (!cfg) {
  console.error('没有 config.json，先跑「设置.bat」。');
  process.exit(1);
}
if (!cfg.bot?.owners?.[0]) {
  console.error('config.json 里 bot.owners 是空的，先在设置里填主人的 QQ 号。');
  process.exit(1);
}
if (!cfg.dsh?.exe || !fs.existsSync(cfg.dsh.exe)) {
  console.error('找不到 DeepSeek Harness.exe（config.json → dsh.exe）。先装桌面端，再跑一次设置。');
  process.exit(1);
}

fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

let child = null;
let stopping = false;
const cleanup = () => {
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(BOT_PID_FILE, { force: true });
};
const stop = () => {
  stopping = true;
  if (child && !child.killed) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  }
  cleanup();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 后台模式：输出进文件
let outFd = null;
if (DETACH) {
  outFd = fs.openSync(path.join(LOGS, 'supervisor.log'), 'a');
}

function launch() {
  if (stopping) return;
  const stdio = DETACH ? ['ignore', outFd, outFd] : 'inherit';
  child = spawn(process.execPath, [path.join(ROOT, 'bot', 'whale-bot.mjs')], {
    cwd: ROOT,
    stdio,
    windowsHide: !DETACH,
    env: { ...process.env },
  });
  if (child.pid) fs.writeFileSync(BOT_PID_FILE, String(child.pid), 'utf8');
  say(`机器人起来了（PID ${child.pid}）`);
  child.on('exit', (code) => {
    fs.rmSync(BOT_PID_FILE, { force: true });
    if (stopping) return;
    say(`机器人退出了（code ${code}），5 秒后重拉`);
    setTimeout(launch, 5000);
  });
}

launch();
