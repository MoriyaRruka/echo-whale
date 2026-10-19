// 本地控制面板：只看本机，绑 127.0.0.1，不连外面。
// 双击「打开面板.bat」跑这个，浏览器会自动打开 http://127.0.0.1:8790
// 功能：看状态 / 启动 停止 重启 / 看日志 / 换模型（换完自动重启，不动别的东西）。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, saveConfig, writeProfile, activeModel } from '../bin/profile.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const RUNTIME = path.join(ROOT, 'runtime');
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(RUNTIME, { recursive: true });

const readPid = (f) => {
  try { return Number(fs.readFileSync(path.join(RUNTIME, f), 'utf8').trim()) || 0; } catch { return 0; }
};
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

function status() {
  const cfg = loadConfig() || {};
  const sup = readPid('supervisor.pid');
  const bot = readPid('bot.pid');
  let since = null;
  try { since = fs.statSync(path.join(RUNTIME, 'bot.pid')).mtimeMs; } catch { /* ignore */ }
  const m = activeModel(cfg);
  const tail = (file, n) => {
    try {
      const buf = fs.readFileSync(path.join(LOGS, file), 'utf8').trimEnd().split('\n');
      return buf.slice(-n).join('\n');
    } catch { return ''; }
  };
  return {
    running: alive(sup),
    botAlive: alive(bot),
    supervisorPid: sup,
    botPid: bot,
    since,
    bot: { qq: cfg.bot?.qq || 0, name: cfg.bot?.name || '', names: cfg.bot?.names || [], owners: cfg.bot?.owners || [] },
    group: cfg.group || { enabled: false, allow: [] },
    model: m ? { name: m.name, model: m.model, baseURL: m.baseURL, hasKey: Boolean(m.apiKey) } : null,
    models: (cfg.models || []).map((x, i) => ({ i, name: x.name, model: x.model })),
    activeModel: Number(cfg.activeModel) || 0,
    dsh: cfg.dsh || {},
    log: tail('supervisor.log', 80),
    botLog: tail('whale-bot.log', 40),
  };
}

function startBot() {
  if (alive(readPid('supervisor.pid'))) return { ok: true, msg: '已经在跑了' };
  spawn(process.execPath, [path.join(ROOT, 'bin', 'start.mjs'), '--detach'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
  return { ok: true, msg: '已让它起来，等几秒刷新' };
}

function stopBot() {
  killTree(readPid('supervisor.pid'));
  killTree(readPid('bot.pid'));
  fs.rmSync(path.join(RUNTIME, 'supervisor.pid'), { force: true });
  fs.rmSync(path.join(RUNTIME, 'bot.pid'), { force: true });
  return { ok: true, msg: '停了' };
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const body = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); }
  });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT, 'panel', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname === '/api/status') return json(res, 200, status());
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const b = await body(req);
      if (b.action === 'start') return json(res, 200, startBot());
      if (b.action === 'stop') return json(res, 200, stopBot());
      if (b.action === 'restart') { stopBot(); return json(res, 200, startBot()); }
      return json(res, 400, { ok: false, msg: '不认识的动作' });
    }
    if (url.pathname === '/api/model' && req.method === 'POST') {
      const b = await body(req);
      const cfg = loadConfig();
      const i = Number(b.index);
      if (!cfg || !cfg.models?.[i]) return json(res, 400, { ok: false, msg: '没有这个模型' });
      cfg.activeModel = i;
      saveConfig(cfg);
      writeProfile(cfg);
      const was = alive(readPid('supervisor.pid'));
      if (was) { stopBot(); startBot(); }
      return json(res, 200, { ok: true, msg: `换成「${cfg.models[i].name}」，${was ? '已重启' : '下次启动生效'}` });
    }
    json(res, 404, { ok: false, msg: '没有这个地址' });
  } catch (e) {
    json(res, 500, { ok: false, msg: String(e?.message || e) });
  }
});

const cfg = loadConfig() || {};
const port = Number(cfg.panel?.port) || 8790;
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log('面板开着：' + url + '（关这个窗口就停）');
  try { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch { /* 自己开浏览器也行 */ }
});
