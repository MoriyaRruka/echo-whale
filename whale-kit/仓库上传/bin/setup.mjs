// 设置向导：填 QQ 号、令牌、自己的模型，然后写 config.json + DSH profile。
// 双击「设置.bat」就是跑这个；随时可以重跑，回车保留原值。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, writeProfile, profileDir, activeModel, kitRoot, applyNameToPersona } from './profile.mjs';

// 输入：自己排队接行，这样双击跑（终端）和管道喂答案都能用
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdout.isTTY) });
const pending = [];
let waiter = null;
rl.on('line', (line) => {
  if (waiter) { const w = waiter; waiter = null; w(line); } else pending.push(line);
});
rl.on('close', () => {
  if (waiter) { const w = waiter; waiter = null; w(''); }
});
process.on('SIGINT', () => { console.log('\n先不设了。'); process.exit(130); });

const ask = (tip, def) => new Promise((resolve) => {
  const d = def === undefined || def === null || def === '' ? '' : String(def);
  stdout.write(`? ${tip}${d ? ` [${d}]` : ''}: `);
  const done = (line) => resolve(String(line).trim() || d);
  if (pending.length) done(pending.shift());
  else waiter = done;
});
const askNum = async (tip, def) => {
  const v = await ask(tip, def);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function findDsh() {
  const guesses = [
    'D:\\DSH\\DeepSeek Harness.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ];
  return guesses.find((p) => fs.existsSync(p)) || '';
}

const cliOf = (exe) => path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

const cfg = loadConfig() || JSON.parse(fs.readFileSync(path.join(kitRoot(), 'config.example.json'), 'utf8'));

console.log('\n=== 小鲸一键包 · 设置 ===');
console.log('回车 = 保留方括号里的原值。\n');

// 1. QQ
cfg.bot = cfg.bot || {};
cfg.bot.qq = await askNum('机器人自己的 QQ 号（NapCat 要登的那个）', cfg.bot.qq || '');

// 1.5 名字：这里不再正式问（定成彩蛋了）。取过名字就显示一下，想换直接输新的。
const oldName = String(cfg.bot.name || '').trim();
if (oldName) {
  console.log(`\n它已经有名字了：${oldName}`);
  const again = await ask('要换个名字吗？想换就直接输新名字，直接回车 = 不改', '');
  if (again.trim()) cfg.bot.name = again.trim();
} else {
  console.log('\n名字不在这儿问了：先叫「小鲸」，等第一次聊天它自己小声问你。');
}
cfg.bot.name = String(cfg.bot.name || '').trim();
if (cfg.bot.name) {
  const keep = (Array.isArray(cfg.bot.names) ? cfg.bot.names : []).filter((x) => x && x !== cfg.bot.name);
  cfg.bot.names = [...new Set([cfg.bot.name, ...keep])];
} else {
  cfg.bot.names = ['小鲸', '鲸鱼'];
}
const owners = (await ask('谁能指挥它（你的 QQ 号，多个用逗号分隔）', (cfg.bot.owners || []).filter(Boolean).join(',')))
  .split(/[,，\s]+/).map(Number).filter(Boolean);
cfg.bot.owners = owners.length ? owners : [0];

// 2. NapCat
cfg.napcat = cfg.napcat || {};
cfg.napcat.wsHost = await ask('NapCat 的 OneBot WebSocket 地址', cfg.napcat.wsHost || 'ws://127.0.0.1:3001');
cfg.napcat.token = await ask('这个 WebSocket 的 token（没设就留空）', cfg.napcat.token || '');

// 3. 群
const g = await ask('要不要开群聊？开就填群号，多个逗号分隔；不开直接回车', (cfg.group?.allow || []).join(','));
cfg.group = {
  enabled: Boolean(g.trim()),
  allow: g.split(/[,，\s]+/).map(Number).filter(Boolean),
  talkAllow: cfg.group?.talkAllow || [],
};
if (cfg.group.enabled) {
  const t = await ask('群里除了你，还允许谁跟它说话？（QQ 号，可空）', (cfg.group.talkAllow || []).join(','));
  cfg.group.talkAllow = t.split(/[,，\s]+/).map(Number).filter(Boolean);
}

// 4. 模型
const m0 = activeModel(cfg) || { name: '默认', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', contextWindow: 131072 };
console.log('\n-- 模型：填你自己的，别用别人的 key --');
const nm = await ask('给这个模型起个名（面板里显示）', m0.name || '默认');
const baseURL = await ask('接口地址（OpenAI 兼容，一般以 /v1 结尾）', m0.baseURL);
const modelName = await ask('模型名', m0.model);
const apiKey = await ask('API key', m0.apiKey || '');
const cw = await askNum('上下文长度（不确定就回车）', m0.contextWindow || 131072);
cfg.models = [{ name: nm, baseURL, apiKey, model: modelName, contextWindow: cw || 131072 }];
cfg.activeModel = 0;

// 5. DSH
const found = findDsh();
console.log('\n-- 大脑：DeepSeek Harness 桌面端（要自己装；包不带你装） --');
const exe = await ask('DeepSeek Harness.exe 的路径', cfg.dsh?.exe || found);
cfg.dsh = { exe, cli: exe ? cliOf(exe) : '', profile: cfg.dsh?.profile || 'echo-kit' };

// 6. 落盘
const problems = [];
if (!cfg.bot.qq) problems.push('没填机器人 QQ 号');
if (!cfg.bot.owners[0]) problems.push('没填主人的 QQ 号');
if (!apiKey) problems.push('没填 API key');
if (!exe || !fs.existsSync(exe)) problems.push('找不到 DeepSeek Harness.exe（装完再跑一次设置，或手填路径）');

if (problems.length) {
  console.log('\n还差这些，先补上再启动：');
  for (const p of problems) console.log('  - ' + p);
  const go = (await ask('照样先存下来？(y/N)', 'N')).toLowerCase();
  if (go !== 'y') {
    console.log('没存，改完再跑一次。');
    rl.close();
    process.exit(1);
  }
}

const saved = saveConfig(cfg);
console.log('\n配置已存：' + saved);
const named = String(cfg.bot.name || '').trim();
try {
  if (applyNameToPersona(cfg)) {
    console.log(named
      ? `名字已写进 home\\AGENTS.md：它叫「${named}」，以后不会再问你要名字。`
      : '没取名：先叫「小鲸」；等第一次聊天聊开了，它自己会小声问你要一个名字（彩蛋，只问一次）。');
  }
} catch (e) {
  console.log('名字没写进人设：' + e.message);
}
if (exe) {
  try {
    const dir = writeProfile(cfg);
    console.log('模型 profile 已写到：' + dir + '（用 ' + activeModel(cfg).model + '）');
  } catch (e) {
    console.log('profile 没写成：' + e.message);
  }
} else {
  console.log('还没找到 DSH，profile 先不写；装好后再跑一次设置。');
}

console.log(`
接下来三件（做过的跳过）：
  1. 装 NapCatQQ，登机器人那个 QQ 号（扫码）；
  2. NapCat 里开 WebSocket 服务器，端口跟上面地址一致（默认 3001），token 跟填的一样；
  3. 双击「启动.bat」，然后在 QQ 里跟它说句话。

要改人设：编辑 home\\AGENTS.md；要发新包：找做这个包的人。
`);
rl.close();
