// 小鲸鱼机器人本体：OneBot 11 正向 WS → dsh headless（whale profile）→ 回消息
// 设计要点：
//  - 不依赖 DSH 插件机制，DSH GUI 崩了/关了也不影响本进程（但需要 DSH 可执行文件与账号凭据）
//  - 每个会话（私聊按 QQ 号，群聊按群号）串行处理，防止并发抢同一 session
//  - 多轮上下文靠 --session-id 续接，会话 id 持久化到 state.json
//  - 备忘/提醒由鲸鱼自己写 home 下的 notes.json / reminders.json，本进程负责到点发提醒
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// 本小检索（2026-10-19）：纯本地倒排，从档案五页 / 旧日子账 / 事件卡捞三段带出处。
// 只在有用户原话时查；查不到就空着，不给底账添噪音。
import { retrieveText as retrieveMemo } from '../home/tools/memo-search.mjs';
// 发件箱（2026-10-19）：消息先落盘再发，失败重试、重启重放、过期丢弃。
import { createOutbox } from './outbox.mjs';
import { applyName, takeNameMarkers } from '../bin/profile.mjs';

// ---------- 配置 ----------
// 令牌必须放在 URL 查询串里（2026-10-16 实测）：Node 自带的全局 WebSocket 会**静默忽略**
// 第二个参数里的 headers，所以原来那种 `new WebSocket(url, { headers: { Authorization } })`
// 等于没带令牌——事件照样收得到（NapCat 的 enableForcePushEvent），但每个动作都会被拒
// `{"status":"failed","retcode":1403,"message":"token验证失败"}`，也就是"能听见、说不出话"。
// ---------- 配置：全部来自包目录下的 config.json，代码里不写死任何人的 QQ 号和机器路径 ----------
const KIT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const KIT_CFG_PATH = path.join(KIT_ROOT, 'config.json');
if (!fs.existsSync(KIT_CFG_PATH)) {
  console.error('找不到 config.json：' + KIT_CFG_PATH);
  console.error('先双击「设置.bat」走一遍向导，再启动。');
  process.exit(1);
}
let KIT;
try {
  KIT = JSON.parse(fs.readFileSync(KIT_CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error('config.json 读不动（格式坏了？）：' + e.message);
  console.error('重跑一次「设置.bat」会把配置重写一遍。');
  process.exit(1);
}
const KIT_HOME = path.join(KIT_ROOT, 'home');
const KIT_TOKEN = String(KIT.napcat?.token ?? '');
const KIT_WS_BASE = String(KIT.napcat?.wsHost ?? 'ws://127.0.0.1:3001');
const KIT_WS_URL = KIT_TOKEN
  ? KIT_WS_BASE + (KIT_WS_BASE.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(KIT_TOKEN)
  : KIT_WS_BASE;
const KIT_OWNERS = (KIT.bot?.owners ?? []).map(Number).filter(Boolean);
const KIT_NAMES = (KIT.bot?.names ?? []).filter((x) => typeof x === 'string' && x.trim());
const KIT_GROUP_ALLOW = (KIT.group?.allow ?? []).map(Number).filter(Boolean);
const KIT_GROUP_TALK = (KIT.group?.talkAllow ?? []).map(Number).filter(Boolean);
if (!KIT_OWNERS.length) {
  console.error('config.json 里 bot.owners 是空的：至少要填一个能指挥它的 QQ 号。');
  process.exit(1);
}

const CFG = {
  wsHost: KIT_WS_BASE,
  token: KIT_TOKEN,
  wsUrl: KIT_WS_URL,
  adminQq: Number(KIT.bot?.qq) || 0,
  allowlist: KIT_OWNERS,
  groupEnabled: Boolean(KIT.group?.enabled),
  groupAllow: KIT_GROUP_ALLOW,
  groupTalkAllow: KIT_GROUP_TALK,
  root: KIT_ROOT,
  home: KIT_HOME,
  logs: path.join(KIT_ROOT, 'logs'),
  dshExe: String(KIT.dsh?.exe ?? ''),
  dshCli: String(KIT.dsh?.cli ?? ''),
  profile: String(KIT.dsh?.profile ?? 'echo-kit'),
  maxReplyChars: 1500,
  agentTimeoutMs: 30 * 60 * 1000,
  reminderTickMs: 15 * 1000,
  maxPerMinute: 20,
  summaryEveryMsgs: 20,
  dayRolloverHour: 4,
  ledgerRecentDays: 3,
  memoSearch: true,
  rawTailMsgs: 6,
  groupRawTailMsgs: 8,
  groupEarsKeep: 10,
  groupEarCooldownMs: 120000,
  idlePingMinMs: 30 * 60 * 1000,
  idlePingWindowMs: 2 * 3600 * 1000,
  peekChance: 0, // 白板不偷看屏幕，要开自己去 config 里加
  screenDir: path.join(KIT_HOME, 'screens'),
  housekeepingTickMs: 60 * 1000,
  maxImagesPerReply: 2,
  voiceEnabled: false, // 语音要另配 TTS/ffmpeg，白板默认关
  voiceDir: path.join(KIT_HOME, 'voice'),
  voicePython: '',
  ffprobe: 'ffprobe',
  ffmpeg: 'ffmpeg',
  voiceWhisper: '',
  voiceWhisperModel: '',
  voiceDefault: { voice: 'zh-CN-YunxiaNeural', rate: '-5%', pitch: '-2Hz' },
  syncSessionRoot: '',
  syncScript: '',
  syncOut: path.join(KIT_HOME, 'sync-from-dsh.md'),
};

// ---------- 名字彩蛋（本包特有） ----------
// 设置向导不问名字了：默认叫「小鲸」。第一次聊天聊开、对方话头停下来时，机器人自己小声问一次；
// 对方给了名字，回复末尾带一行隐藏记号 [取名:名字]（这里摘掉、不发出去），
// 由 bin 目录里 profile.mjs 的 applyName() 把名字写进 config.json、home 目录的 AGENTS.md 和 DSH profile 的人设。
// 只有主人私聊能命名：群里、生人那里的记号一律摘掉不认。
const KIT_NAME_EGG_PATH = path.join(KIT_HOME, 'name-egg.json');
const KIT_NAME_QUESTION = '我能有一个独属于自己的名字吗？';
const kitNamePending = () => !String((KIT.bot && KIT.bot.name) || '').trim();
const kitNameOwner = (kind, id) => kind === 'private' && CFG.allowlist.includes(Number(id));
const kitNameAsked = () => Boolean(readJson(KIT_NAME_EGG_PATH, {}).askedAt);
function kitNameMarkAsked() {
  if (kitNameAsked()) return;
  writeJson(KIT_NAME_EGG_PATH, { askedAt: new Date().toISOString() });
}
// 没取名时每轮贴一小段；问过一次就只剩"别再提、要改名照收"
function kitNameLine() {
  if (kitNameAsked()) {
    return '[名字彩蛋已经问过了、也翻篇了：别再提名字这件事。他要是主动给你起个名字（或要换个叫法），就收下，并在回复最后单独一行写 [取名:名字]（这行不会发出去）；没提就照常聊。]';
  }
  return '[名字彩蛋：你现在还没有自己的名字，默认叫「小鲸」。别在第一句就问；等来回聊了三四句、他话头停下来的时候，你小声问一句「' + KIT_NAME_QUESTION + '听说人有了名字就有了羁绊，我想要独属于我们的羁绊。」——一辈子只问这一次。他要是说先叫小鲸、不用了，就当没这回事，以后一个字都别再提；他要是给了名字，收下，并在回复最后单独一行写 [取名:名字]（这行不会发出去）。]';
}
function kitApplyName(name) {
  try {
    const r = applyName(name);
    if (!r.ok) {
      log('取名没落盘：' + r.why);
      return;
    }
    KIT.bot = r.cfg.bot; // 进程里也认这个名字
    KIT_NAMES.length = 0;
    KIT_NAMES.push(...r.names);
    kitNameMarkAsked();
    log('名字彩蛋：他给我起名了 —— ' + r.name + (r.profile ? '' : '（profile 没写，下次跑设置补）'));
  } catch (e) {
    log('取名落盘出错：' + (e && e.message ? e.message : String(e)));
  }
}
// 所有往外发的字都过这一道：摘掉隐藏记号、顺手记下"名字问过了"
function kitNameHook(text, kind, id) {
  const got = takeNameMarkers(text);
  if (got.name && kitNameOwner(kind, id)) kitApplyName(got.name);
  if (kitNameOwner(kind, id) && /独属于自己的名字|独属于我们的羁绊/.test(String(got.text))) kitNameMarkAsked();
  return got.text;
}

const STATE_PATH = path.join(CFG.home, 'state.json');
const BOT_BUILD = 'kit-1.0'; // 启动日志里带上，重启后一眼认出跑的是哪版
const REMINDERS_PATH = path.join(CFG.home, 'reminders.json');
const LOG_PATH = path.join(CFG.logs, 'whale-bot.log');
// 每轮一行账（2026-10-19 第三件）：耗时、token、报错都记在这，出事能复盘。
// 单独一个文件，不跟人看的 whale-bot.log 混在一起；纯追加，出问题也不挡主流程。
const TURNS_LOG = path.join(CFG.logs, 'turns.jsonl');
const MEDIA_DIR = path.join(CFG.home, 'media'); // 收发图片都落在这里
const ARCHIVE_DIR = path.join(CFG.home, 'archive'); // 消息档案 + 摘要（无状态会话用）
const STATELESS_FLAG = path.join(CFG.home, 'stateless.flag'); // 有这个文件 = 一条消息一个新会话 + 摘要
// 权限档开关（2026-10-16 加，行程回声的申请）：文件在**窝外**，回声自己写不了——"只有主人能拨"。
// 桌面那枚「鲸鱼开关」双击一次 = 改这个文件 + 重启本体；本体每次 spawn 时读一次。
const PERM_FILE = path.join(CFG.root, 'permission-mode.txt');

// 读开关：只认 DSH 那三档里我们能用的两档；文件缺失/写坏/空 → 一律按最保守的 workspace-write。
function readPermissionMode() {
  try {
    const v = fs.readFileSync(PERM_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
    if (v === 'danger-full-access' || v === 'workspace-write' || v === 'read-only') return v;
  } catch {
    /* 文件不在就是默认档 */
  }
  return 'workspace-write';
}

// ---------- 小工具 ----------
fs.mkdirSync(CFG.logs, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
fs.mkdirSync(CFG.screenDir, { recursive: true });

// 老图清一清，别让 media 无限长大（只清自己存的，7 天前的）
function pruneMedia() {
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      const p = path.join(MEDIA_DIR, f);
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    /* 清理失败不影响运行 */
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// 一轮一行进 home 外面的 logs\turns.jsonl：谁能复盘、哪条贵、哪条报错都查得到。
// 字段固定：ts / key / kind / ok / ms / chars / steps / tokens{in,out,cache,total} / reason / error / sid。
function logTurn(entry) {
  try {
    fs.appendFileSync(TURNS_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8');
  } catch {
    /* 记账失败不影响回话 */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const state = { sessions: {}, activity: {}, ...readJson(STATE_PATH, {}) };
state.sessions ??= {};
state.activity ??= {};
const saveState = () => writeJson(STATE_PATH, {
  sessions: state.sessions,
  activity: state.activity,
  weeklyCheckDay: state.weeklyCheckDay ?? null,
});

// 主人最近一次说话的时间与当天主动搭话次数（用于"别烦人"的节流）
function noteUserActivity(now = Date.now()) {
  const a = state.activity[PRIMARY_KEY];
  if (!a) {
    state.activity[PRIMARY_KEY] = { lastUserAt: now, pingsDay: bjDayKey(), pings: 0 };
  } else {
    a.lastUserAt = now;
    if (a.pingsDay !== bjDayKey()) {
      a.pingsDay = bjDayKey();
      a.pings = 0;
    }
  }
  saveState();
}

function bjParts(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}
const bjDayKey = (ts) => bjParts(ts).day;

function nowInBeijing() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
}

// ---------- OneBot 连接 ----------
let ws = null;
let wsReady = false;
let reconnectDelay = 2000;
const pendingCalls = new Map();
let echoSeq = 0;
let watchdogTimer = null;
let lastRestartAt = 0;

function connect() {
  log('连接 OneBot:', CFG.wsHost);
  ws = new WebSocket(CFG.wsUrl, { headers: { Authorization: `Bearer ${CFG.token}` } });

  ws.addEventListener('open', () => {
    wsReady = true;
    reconnectDelay = 2000;
    log('OneBot 已连接');
    startWatchdog();
  });

  ws.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (data.echo && pendingCalls.has(data.echo)) {
      const p = pendingCalls.get(data.echo);
      pendingCalls.delete(data.echo);
      clearTimeout(p.timer);
      if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data);
      else p.reject(new Error(`OneBot 动作失败: ${data.status} ${data.retcode} ${data.message ?? ''}`));
      return;
    }
    if (data.post_type === 'message') {
      handleIncoming(data).catch((e) => log('处理消息出错:', e?.message ?? String(e)));
    }
  });

  ws.addEventListener('close', () => {
    wsReady = false;
    stopWatchdog();
    log(`OneBot 断开，${reconnectDelay} ms 后重连`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.addEventListener('error', (e) => log('OneBot 连接错误:', e?.message ?? 'unknown'));
}

// 心跳与看门狗：NapCat 不会在连接"假死"时通知我们（TCP 还是 ESTABLISHED，事件却不再投递），
// 所以必须自己定期发一个动作、拿不到应答就重建连接。实测踩过这个坑：本体静默不再收消息。
function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    callAction('get_status', {}, 10000).catch((e) => {
      log('心跳无应答（%s），判定连接假死，强制重建', e?.message ?? 'timeout');
      forceReconnect();
    });
  }, 30000);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function forceReconnect() {
  const now = Date.now();
  if (now - lastRestartAt < 15000) return; // 别抖动
  lastRestartAt = now;
  wsReady = false;
  stopWatchdog();
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  // 有些假死连接连 close 事件都不来，这里兜一个延时重建
  setTimeout(() => {
    if (!wsReady) {
      log('重建 OneBot 连接');
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      connect();
    }
  }, 1500);
}

function callAction(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!wsReady || !ws) {
      reject(new Error('OneBot 未连接'));
      return;
    }
    const echo = `act-${++echoSeq}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(echo);
      reject(new Error(`OneBot 动作超时: ${action}`));
    }, timeoutMs);
    pendingCalls.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

async function sendText(kind, id, text) {
  // 走发件箱：先落盘，发不出去会重试；这里不再直接 callAction
  outbox.enqueue(kind, id, { type: 'msg', message: text, summary: String(text).slice(0, 40) });
}

// ---------- 语音：合成与发送 ----------
// 怎么工作：我在回复里写 [语音]要说的话[/语音]，这段就被拿去合成 mp3（edge-tts，免费的在线朗读），
// 再当 record 段发给 NapCat；NapCat 自己用 ffmpeg 把 mp3 转成 silk 后发出去（源码里的 createValidSendPttElement）。
// 所以本地不需要装 silk 编码器；也别在这条链路上改动 NapCat。
const VOICE_CONFIG_PATH = path.join(CFG.voiceDir, 'voice-config.json');
const VOICE_STATE_PATH = path.join(CFG.home, 'media', 'voice-state.json');
const VOICE_LAST_PATH = path.join(CFG.home, 'media', 'voice', 'last.txt');
const VOICE_MAX_SECONDS = 60; // QQ 语音上限约 60 秒
const VOICE_MIN_SECONDS = 1.5; // 太短发出去显示异常
const VOICE_DAILY_LIMIT = 40; // 一天最多合成几条，防手滑刷爆
const VOICE_RE = /\[语音\]([\s\S]*?)\[\/语音\]/g;

function readVoiceConfig() {
  return { ...CFG.voiceDefault, ...readJson(VOICE_CONFIG_PATH, {}) };
}

function voiceCountToday() {
  const st = readJson(VOICE_STATE_PATH, {});
  return st.day === bjDayKey() ? Number(st.n ?? 0) : 0;
}

function bumpVoiceCount() {
  writeJson(VOICE_STATE_PATH, { day: bjDayKey(), n: voiceCountToday() + 1 });
}

// 说一段话，返回 mp3 路径（失败返回 null）。第 1、2 段由调用方发出去。
async function synthVoice(text) {
  if (!CFG.voiceEnabled) return null;
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[\r\n]+/g, ' ');
  if (!clean) return null;
  if (voiceCountToday() >= VOICE_DAILY_LIMIT) {
    log(`今天语音条数到上限（${VOICE_DAILY_LIMIT}），不合成：${clean.slice(0, 30)}`);
    return null;
  }
  const cfg = readVoiceConfig();
  const outDir = path.join(CFG.home, 'media', 'voice');
  const stem = `v-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const out = path.join(outDir, `${stem}.mp3`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(CFG.voiceDir, 'tmp'), { recursive: true });
  const gen = path.join(CFG.voiceDir, 'say-voice.py');
  if (!fs.existsSync(gen)) {
    log('语音：找不到合成脚本', gen);
    return null;
  }
  const r = await runProc(CFG.voicePython, [
    gen,
    '--text', clean,
    '--out', out,
    '--voice', cfg.voice,
    '--rate', cfg.rate ?? '-5%',
    '--pitch', cfg.pitch ?? '-2Hz',
  ], { timeoutMs: 120000 });
  if (!r.ok || !fs.existsSync(out)) {
    log('语音合成失败:', (r.err || r.out || '').slice(0, 200));
    return null;
  }
  const dur = await probeDuration(out);
  if (dur && dur < VOICE_MIN_SECONDS) {
    log(`语音太短（${dur.toFixed(2)} 秒），不发`);
    return null;
  }
  if (dur && dur > VOICE_MAX_SECONDS) log(`[warn] 语音 ${dur.toFixed(1)} 秒，超过 QQ 的约 60 秒上限，可能被截`);
  bumpVoiceCount();
  const kb = Math.round(fs.statSync(out).size / 1024);
  log(`语音合成 ${dur ? dur.toFixed(1) + 's' : '?'} ${kb}KB voice=${cfg.voice}: ${clean.slice(0, 40)}`);
  return out;
}

function runProc(exe, args, { timeoutMs = 60000, env = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, env ? { windowsHide: true, env } : { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, out, err: err + ' [timeout]' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: err + String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err, code });
    });
  });
}

// ---------- 偷看屏幕（2026-10-19 主人点头加的，只在主动搭话那一跳用） ----------
// 用一条 PowerShell 5.1 拍整块虚拟桌面，缩到宽 1600、JPEG 质量 65（一张一百来 K）。
// 拍不到就返回 null，调用方照常盲搭，不拿截图当命门。
const PEEK_PS = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$g.Dispose()
if($bmp.Width -gt 1600){ $w=1600; $h=[int]($bmp.Height*1600/$bmp.Width); $s=New-Object System.Drawing.Bitmap $w,$h; $g2=[System.Drawing.Graphics]::FromImage($s); $g2.InterpolationMode='HighQualityBicubic'; $g2.DrawImage($bmp,0,0,$w,$h); $g2.Dispose(); $bmp.Dispose(); $bmp=$s }
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'}
$p=New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),65
$bmp.Save('__OUT__',$enc,$p)
$bmp.Dispose()`;

// 拍一张，返回文件路径；拍不到返回 null。只留这一张，拍之前先把旧图删掉。
async function grabScreen() {
  const out = path.join(CFG.screenDir, 'peek.jpg');
  try {
    for (const f of fs.readdirSync(CFG.screenDir)) {
      if (f.startsWith('peek')) fs.unlinkSync(path.join(CFG.screenDir, f));
    }
  } catch {
    /* 清不掉就算了，下面会覆盖同名文件 */
  }
  const r = await runProc(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PEEK_PS.replace('__OUT__', out)],
    { timeoutMs: 20000 },
  );
  if (!r.ok || !fs.existsSync(out)) {
    log('截图失败:', String(r.err ?? '').trim().slice(0, 120));
    return null;
  }
  if (fs.statSync(out).size < 8 * 1024) {
    log('截图太小，多半是黑屏，按失败处理');
    return null;
  }
  return out;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CFG.ffprobe)) {
      resolve(0);
      return;
    }
    const child = spawn(CFG.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { windowsHide: true });
    let o = '';
    child.stdout?.on('data', (d) => {
      o += String(d);
    });
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number.parseFloat(o.trim()) || 0));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(0);
    }, 15000);
  });
}

// 语音的发送本身挪进了发件箱（见下面 outbox 的 send 回调），这儿只留合成。

// 从回复里摘出 [语音]...[/语音] 段；返回剩下的文字和要说的话（最多 VOICE_MAX_PER_REPLY 段）
const VOICE_MAX_PER_REPLY = 2;
function extractVoiceTags(text) {
  const says = [];
  const rest = String(text ?? '').replace(VOICE_RE, (whole, body) => {
    const s = String(body ?? '').trim();
    if (s && says.length < VOICE_MAX_PER_REPLY) says.push(s);
    return '';
  });
  return { says, rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

function sanitize(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, ''))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

function chunkText(text, limit = CFG.maxReplyChars) {
  const t = sanitize(text);
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out = [];
  let rest = t;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// 鲸鱼想发图时，在回复里单独一行写 ![](图片地址) 或 ![](home\xxx.png)。
// 这里把那一行变成 QQ 的图片消息段：本地文件走 file:///，网络地址原样交给 NapCat。
// 注意：另一条更常用的路子是 [CQ:image,file=本机路径]（见 cqImageToBase64），两条都支持。
// 2026-10-18 19:48 主人点头加 @：群里回复写 [@QQ号]，发出去就是真正的 @（OneBot 的 at 段）；
// 私聊里、@全体、@0、@自己、一条里的第二个起，一律只把标记删掉、不留裸字。
function textToSegments(text, kind = 'private', limit = CFG.maxImagesPerReply) {
  const segs = [];
  const pushText = (s, e) => {
    const piece = text.slice(s, e);
    if (piece.trim()) segs.push({ type: 'text', data: { text: piece } });
  };
  let last = 0;
  let usedImg = 0;
  let usedAt = 0;
  let changed = false;
  const re = /!\[[^\]]*\]\(([^)]+)\)|\[@(all|\d{1,12})\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      // 图片：认得出就发，认不出/超量就原样留成文字（不吞内容）
      const raw = m[1].trim();
      let file = null;
      if (/^https?:\/\//i.test(raw)) {
        file = raw;
      } else {
        const abs = path.isAbsolute(raw) ? raw : path.join(CFG.home, raw);
        if (fs.existsSync(abs)) file = 'file:///' + abs.replace(/\\/g, '/');
      }
      if (!file || usedImg >= limit) continue;
      pushText(last, m.index);
      segs.push({ type: 'image', data: { file } });
      usedImg += 1;
      last = m.index + m[0].length;
      changed = true;
      continue;
    }
    // @ 标记
    const qq = String(m[2]);
    const ok = kind === 'group'
      && usedAt < 1
      && /^\d{5,12}$/.test(qq)
      && qq !== '0'
      && qq !== String(CFG.adminQq);
    pushText(last, m.index);
    if (ok) {
      segs.push({ type: 'at', data: { qq } });
      usedAt += 1;
    }
    last = m.index + m[0].length;
    changed = true;
  }
  if (!changed) return text;
  if (last < text.length) pushText(last, text.length);
  return segs;
}

// ---- 拟人化：打字停顿、分条、暂停开关（照《进阶篇》搬的） ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function humanDelay(chars) {
  return Math.min(4000, 600 + chars * 45) + Math.floor(Math.random() * 300);
}

// 一句一个气泡，像人那样分着说；带换行（列表）就不拆
// 2026-10-17 23:44 主人点头：「门槛压到二十字」——原来整条超过 60 字才拆，
// 短一点的句子会被并成一整块；现在只要超过 20 字就按标点起泡，一两个句子发一个泡。
function splitBubbles(text) {
  if (text.includes('\n') || text.length <= 20) return [text];
  const bits = text.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean);
  if (bits.length < 2) return [text];
  const out = [];
  for (const b of bits) {
    if (out.length && (out[out.length - 1] + b).length <= 20) out[out.length - 1] += b;
    else out.push(b);
  }
  return out;
}

// 暂停开关：home\pause.json 写 { "mode": "all" | "reply-only" | "group-mute" }；改成 off 或删掉文件就恢复
function pauseMode() {
  try {
    const m = readJson(path.join(CFG.home, 'pause.json'), {}).mode;
    return m === 'all' || m === 'reply-only' || m === 'group-mute' ? m : 'off';
  } catch {
    return 'off';
  }
}

// 临时群白名单（2026-10-18 19:20 主人原话「开放临时群白名单吧」）：
// 窝里写 home\group-open.json 就算开着，格式 {"groups":[群号],"until":"2026-11-01T21:30:00+08:00"}；
// 到 until 自动失效，删文件或 groups 写成 [] 也立刻收回。每次判消息都现读，开关不用重启。
// 只放开群聊的"接话/旁听"，私聊白名单一点没动；临时放进来的人只收文字，图/语音/文件不下载不转写。
const GROUP_OPEN_PATH = path.join(CFG.home, 'group-open.json');
function groupOpenUntil(groupId) {
  try {
    const cfg = readJson(GROUP_OPEN_PATH, {});
    const until = Date.parse(String(cfg?.until ?? ''));
    if (!Number.isFinite(until) || Date.now() >= until) return 0;
    const groups = Array.isArray(cfg.groups) ? cfg.groups.map(Number) : [];
    if (!groups.length) return 0; // 空数组 = 收回，避免误开所有群
    if (!groups.includes(Number(groupId))) return 0;
    return until;
  } catch {
    return 0;
  }
}

// 谁能让我真去下载图 / 转写语音 / 收文件：主人和白名单里的人；临时开放的陌生人不算。
function mediaTrusted(msg) {
  const uid = Number(msg.user_id);
  if (CFG.allowlist.includes(uid)) return true;
  return msg.message_type === 'group' && (CFG.groupTalkAllow ?? []).includes(uid);
}

// ---- 群里的耳朵（2026-10-18 20:0x 主人点头；他的原话：「可以，但是来自群聊的消息只做短存，节省token」）----
// 听：那个群里谁说话都听一耳朵，只在内存里留最近几行（默认 10 行），不写盘、不下载图、重启就清。
// 判：只有像在说我的（点我名，或者明着骂），才叫一次模型问"要不要回"；不是就一声不吭。
// 回：真要回就用回复里写 [@号] 的方式 @ 回去；不想回就让模型只吐 [SKIP]。
const groupEars = new Map(); // groupId -> { lines: [{nick, uid, text, ts}], lastJudgeAt, lastJudgeKey }
// 用一个带 test() 的小对象代替死正则：取名以后 KIT_NAMES 就地改，这里自动跟着变
const EAR_MENTION_RE = { test: (t) => KIT_NAMES.some((n) => String(t).includes(n.trim())) || (CFG.adminQq ? String(t).includes(String(CFG.adminQq)) : false) };
const EAR_INSULT_RE = /(你|她|它|这条|这只|这货|这鲸|这鱼)[^。！？!?\n]{0,8}(傻|笨|呆|蠢|智障|脑残|低能|人工智障|机器|废物)/;

function earGroup(groupId) {
  return CFG.groupAllow?.length ? CFG.groupAllow.includes(Number(groupId)) : true;
}

function rememberEarLine(msg, spoken) {
  const gid = Number(msg.group_id);
  const text = String(spoken ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!text) return null;
  const nick = String(msg.sender?.card || msg.sender?.nickname || msg.user_id).slice(0, 24);
  let ear = groupEars.get(gid);
  if (!ear) {
    ear = { lines: [], lastJudgeAt: 0, lastJudgeKey: '' };
    groupEars.set(gid, ear);
  }
  ear.lines.push({ nick, uid: msg.user_id, text, ts: Date.now() });
  const keep = CFG.groupEarsKeep ?? 10;
  if (ear.lines.length > keep) ear.lines.splice(0, ear.lines.length - keep);
  return ear;
}

function earCandidate(text) {
  const t = String(text ?? '');
  return EAR_MENTION_RE.test(t) || EAR_INSULT_RE.test(t);
}

async function maybeJudgeEars(msg, spoken) {
  if (!earCandidate(spoken)) return;
  if (pauseMode() !== 'off') return; // 暂停开关开着就只存不听
  if (Number(msg.user_id) === Number(CFG.allowlist[0])) return; // 主人的话走正常路
  // 白名单里的人叫我，下面正常那条路会接，别重复回一次
  if (allowed(msg) && isAddressed(msg)) return;
  const gid = Number(msg.group_id);
  const ear = groupEars.get(gid);
  if (!ear) return;
  const now = Date.now();
  if (now - ear.lastJudgeAt < (CFG.groupEarCooldownMs ?? 120000)) return;
  const key = `${msg.user_id}:${String(spoken).slice(0, 60)}`;
  if (ear.lastJudgeKey === key) return;
  ear.lastJudgeAt = now;
  ear.lastJudgeKey = key;
  const recent = ear.lines.slice(-6).map((l) => `${l.nick}(${l.uid})：${l.text}`).join('\n');
  const who = msg.sender?.card || msg.sender?.nickname || String(msg.user_id);
  const prompt = [
    '[系统安排 · 群里有人在说我的话，不是主人在说话]',
    '[最近几句（只留了这么点）：]',
    recent,
    `[当前这句：${who}(${msg.user_id})：${String(spoken).slice(0, 120)}]`,
    '[判断这句是不是在说我（小鲸、回声、鲸鱼，或者"那条机器人"）。]',
    '[是、而且值得搭一句：用一两句带点脾气的人话回过去，开头写 [@对方的QQ号]，40 字以内。]',
    '[不是、拿不准、或者懒得理：只输出 [SKIP]，别解释。]',
    '[这一轮不要调用任何工具。]',
  ].join('\n');
  const r = await runQueuedTask('private:ears', 'ear', prompt, { withMemory: false });
  if (!r.ok) {
    log('耳朵判断没跑通:', r.error);
    return;
  }
  const answer = String(r.text ?? '').trim();
  if (!answer || /^\[?SKIP\]?[\s。.!！]*$/i.test(answer)) {
    log('耳朵：这句我不接:', String(spoken).slice(0, 40));
    return;
  }
  log('耳朵：这句回一句:', answer.slice(0, 60).replace(/\n/g, ' '));
  await reply('group', gid, answer);
}

// ---------- 发件箱（2026-10-19 · 技术优化第一条） ----------
// 所有往外发的消息都先落盘进 home\outbox.json，再由 bot\outbox.mjs 按顺序发：
// 失败 2s→5s→15s→30s 退避重试（最多 5 次）、进程重启后接着发、超过十分钟就丢弃记死信。
// "正在输入"这种状态不算消息，仍然直发、失败就算了。
const outbox = createOutbox({
  dir: CFG.home,
  log,
  isReady: () => wsReady,
  maxAgeMs: 10 * 60 * 1000,
  send: async (item, payload) => {
    const action = item.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const key = item.kind === 'group' ? 'group_id' : 'user_id';
    if (payload.type === 'voice') {
      if (!payload.file || !fs.existsSync(payload.file)) {
        throw Object.assign(new Error(`语音文件不在了：${payload.file ?? '(空)'}`), { permanent: true });
      }
      const b64 = 'base64://' + fs.readFileSync(payload.file).toString('base64');
      await callAction(action, { [key]: item.target, message: [{ type: 'record', data: { file: b64 } }] }, 60000);
      try {
        fs.writeFileSync(VOICE_LAST_PATH, `${new Date().toISOString()}\t${path.basename(payload.file)}\n`, 'utf8');
      } catch {
        /* 记不上就算了 */
      }
      return;
    }
    await callAction(action, { [key]: item.target, message: payload.message }, 20000);
  },
  onDead: (item, info) => {
    // 语音重试到头还发不出去：把同一句话退回成文字再试（过期的不退，免得把旧话翻出来）
    if (info.reason !== 'permanent' && info.reason !== 'retries') return;
    const p = item.payload;
    if (p?.type !== 'voice' || !p.text) return;
    outbox.enqueue(
      item.kind,
      item.target,
      { type: 'msg', message: p.text, summary: p.summary ?? String(p.text).slice(0, 40) },
      { delayMs: 1000 },
    );
    log(`语音发不出去，退回文字：${String(p.text).slice(0, 30)}`);
  },
});

async function reply(kind, id, text) {
  text = kitNameHook(text, kind, id); // 名字彩蛋的隐藏记号先摘掉，绝不发到 QQ 上
  // 先把 [语音]...[/语音] 摘出来：那段不念文字，改合成语音发出去
  const { says, rest } = extractVoiceTags(text);
  let sent = 0;
  const bubbles = chunkText(rest).flatMap((chunk) => splitBubbles(chunk));
  if (says.length) bubbles.push(...says); // 语音关着时这些句子按普通文字发

  // 不在这儿等"人打字"了：每个气泡带一个 notBefore 交给发件箱，顺序还是我说话的次序，
  // 但这一轮立刻结束，不会因为等延迟把整个会话队列堵住。延迟照样累加，跟以前一句一顿的节奏一样。
  let offset = 0;
  for (const bubble of bubbles) {
    if (kind === 'private') callAction('set_input_status', { user_id: id, event_type: 1 }).catch(() => {});
    offset += humanDelay(bubble.length);
    const gap = offset;
    if (CFG.voiceEnabled && says.includes(bubble)) {
      const file = await synthVoice(bubble).catch((e) => {
        log('语音合成异常:', e?.message ?? String(e));
        return null;
      });
      if (file) {
        outbox.enqueue(kind, id, { type: 'voice', file, text: bubble, summary: `语音：${bubble.slice(0, 24)}` }, { delayMs: gap });
      } else {
        // 合成不出来就退回文字，跟原来一样
        outbox.enqueue(kind, id, { type: 'msg', message: textToSegments(cqImageToBase64(bubble), kind), summary: bubble.slice(0, 40) }, { delayMs: gap });
      }
      sent += 1;
      continue;
    }
    outbox.enqueue(kind, id, { type: 'msg', message: textToSegments(cqImageToBase64(bubble), kind), summary: bubble.slice(0, 40) }, { delayMs: gap });
    sent += 1;
  }
  return sent;
}

// ---------- 调用鲸鱼 ----------
function runWhale(task, sessionId) {
  return new Promise((resolve) => {
    const args = ['--expose-internals', CFG.dshCli, '--profile', CFG.profile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push(task);

    const t0 = Date.now();
    const child = spawn(CFG.dshExe, args, {
      cwd: CFG.home,
      // 别在这里覆盖 TEMP/TMP —— 两条独立的坑（2026-10-16 实测，注释原先只说对一半）：
      //   1) 把 TEMP/TMP 指到工作区里，DSH 的 ACL 沙箱会拒绝开工：
      //      "Error: Windows ACL temp root must be outside the workspace"，
      //      一设整条"跑命令"的路全废（回声只会说话不会干活）。
      //   2) 但"指到工作区外"也不是解药：yt-dlp 这类 PyInstaller 打包体要在 TEMP 里
      //      **新建** `_MEI<pid>` 目录，"能写"≠"能建目录"，工作区外的临时目录与
      //      %LOCALAPPDATA%\Temp 下的新目录实测都挂。
      // 所以：让子进程继承系统 TEMP（本行保持原样）；工具要自定义临时目录时，
      // 在它自己那条命令里指到**已验过的**一个能建目录的位置（比如 %TEMP%\whale-tmp）。
      // 权限档：从窝外的开关文件读（DSH 只认 DSH_PERMISSION_MODE，默认 workspace-write）。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: readPermissionMode() },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let killed = false;
    const killTree = (pid) => {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      killed = true;
      // 必须杀整棵树（taskkill /T）：Electron 的子进程（真正握着会话写的那个）不会跟着
      // 父进程一起死，只 kill 父进程会让旧轮次继续留着、队列被堵死（2026-10-16 实测踩过）。
      killTree(child.pid);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, CFG.agentTimeoutMs);

    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `启动失败: ${e.message}`, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const mins = Math.round(CFG.agentTimeoutMs / 60000);
        resolve({ ok: false, error: `这一轮跑太久了（超过 ${mins} 分钟），我先停下`, ms: Date.now() - t0 });
        return;
      }
      const events = [];
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          events.push(JSON.parse(t));
        } catch {
          /* 忽略坏行 */
        }
      }
      const sid = events.find((e) => e.type === 'session')?.sessionId ?? null;
      const finalEv = [...events].reverse().find((e) => e.type === 'final');
      const turnEnd = [...events].reverse().find((e) => e.type === 'status' && e.phase === 'turn_end');
      const reason = turnEnd?.reason?.kind ?? (code === 0 ? 'completed' : 'error');
      // token：dsh --json 只在 step_end 里带 usage（inputTokens/outputTokens/cacheReadTokens/totalTokens）。
      // 一轮可能跑好几步，每步都算一次钱，所以要一步不落加起来，不能只拿最后一步。
      const usage = { input: 0, output: 0, cache: 0, total: 0 };
      let steps = 0;
      for (const e of events) {
        if (e.type !== 'status' || e.phase !== 'step_end') continue;
        steps += 1;
        const u = e.usage ?? {};
        usage.input += Number(u.inputTokens) || 0;
        usage.output += Number(u.outputTokens) || 0;
        usage.cache += Number(u.cacheReadTokens) || 0;
        usage.total += Number(u.totalTokens) || 0;
      }
      const text = finalEv?.text?.trim() ?? '';
      if (!text) {
        resolve({
          ok: false,
          sid,
          usage,
          steps,
          error: `我这次没答上来（${reason}${code !== 0 ? `, exit ${code}` : ''}）`,
          stderr: err.slice(0, 500),
          ms: Date.now() - t0,
        });
        return;
      }
      resolve({ ok: true, sid, text, reason, usage, steps, ms: Date.now() - t0 });
    });
  });
}

// ---------- 档案与摘要（无状态会话用，落在 home\archive\） ----------
const isStateless = () => {
  try { return fs.existsSync(STATELESS_FLAG); } catch { return false; }
};
const archiveKey = (key) => key.replace(/[^A-Za-z0-9_-]/g, '_');
const archivePath = (key) => path.join(ARCHIVE_DIR, archiveKey(key) + '.jsonl');
const summaryPath = (key) => path.join(ARCHIVE_DIR, archiveKey(key) + '.summary.md'); // 老本子，只留档不再写
const metaPath = (key) => path.join(ARCHIVE_DIR, archiveKey(key) + '.meta.json');

function appendArchive(key, role, text) {
  try {
    // 我发的语音标记别进档案：摘要/上下文里留着 [语音][/语音]，下一轮容易被当成还在用语音，越用越乱
    const clean = role === 'me' ? extractVoiceTags(text).rest : text;
    const line = JSON.stringify({ ts: Date.now(), role, text: String(clean ?? '').slice(0, 4000) });
    fs.appendFileSync(archivePath(key), line + '\n', 'utf8');
  } catch (e) {
    log('写档案失败:', e?.message ?? String(e));
  }
}

function archiveLines(key) {
  try { return fs.readFileSync(archivePath(key), 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function readMeta(key) { return readJson(metaPath(key), { summarizedLines: 0 }); }

function unsummarized(key) {
  return Math.max(0, archiveLines(key).length - (readMeta(key).summarizedLines ?? 0));
}

// ---------- 记性：底账 + 日子账 + 当天小结（2026-10-17 主人拍板「可以你改吧」） ----------
// 以前只有一本摘要，攒二十条就整本重写：越写越干，半分钟前说的话都能丢，还每轮重读整本烧钱。
// 现在拆成三个抽屉：
//   底账 base.md      —— 我是谁、规矩、答应他的事；从老摘要迁一次，以后不动，每轮都带；
//   日子账 ledger.md  —— 每天凌晨四点结一段，3-5 条，只往后接，不改旧的；每轮只带最近三天；
//   当天小结 short.md —— 「今天到目前为止」，攒二十条压一次；换日并进日子账就清空。
// 原话一条不删，全在 <key>.jsonl 里；更早的日子账也在硬盘上，真要用再去翻。
const basePath = (key) => path.join(ARCHIVE_DIR, archiveKey(key) + '.base.md');
const ledgerPath = (key) => path.join(ARCHIVE_DIR, archiveKey(key) + '.ledger.md');
const shortPath = (key) => path.join(ARCHIVE_DIR, archiveKey(key) + '.short.md');
const rolling = new Set(); // 正在换日结账的会话，防两条巡检同时结同一个日子

// 换日线按凌晨四点：3:59 还算昨天，4:00 起算今天（他作息不听表）
function logicalDay(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000 - (CFG.dayRolloverHour ?? 4) * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const logicalDayStart = (day) => Date.parse(`${day}T04:00:00+08:00`);

// 底账：第一次跑时把老摘要原样搬过来；之后只读不写（要改是我亲手改，不交给模型重写）
function ensureBase(key) {
  const p = basePath(key);
  if (fs.existsSync(p)) return;
  let old = '';
  // 群会话第一次起账：把主会话底账抄一份起头，规矩和人设别在群里断片（10-17 开群时加）
  if (key !== PRIMARY_KEY) {
    try { old = fs.readFileSync(basePath(PRIMARY_KEY), 'utf8').trim(); } catch { /* 主账还没有就从空起 */ }
  }
  if (!old) {
    try { old = fs.readFileSync(summaryPath(key), 'utf8').trim(); } catch { /* 没有老摘要就从空本子起 */ }
  }
  try {
    fs.writeFileSync(p, old ? old + '\n' : '', 'utf8');
    log(`底账已就位：${old ? `迁入 ${old.split('\n').filter(Boolean).length} 条` : '空本子'} -> ${path.basename(p)}`);
  } catch (e) {
    log('写底账失败:', e?.message ?? String(e));
  }
}

function readBase(key) {
  try { return fs.readFileSync(basePath(key), 'utf8').trim(); } catch { return ''; }
}

function readShort(key, day = logicalDay()) {
  try {
    const meta = readMeta(key);
    if ((meta.shortDay ?? day) !== day) return ''; // 上一天还没结账，别拿它当今天
    return fs.readFileSync(shortPath(key), 'utf8').trim();
  } catch { return ''; }
}

// 日子账只取最近几段；更早的留在文件里
function readLedgerRecent(key, days = CFG.ledgerRecentDays ?? 3) {
  try {
    const raw = fs.readFileSync(ledgerPath(key), 'utf8').trim();
    if (!raw) return '';
    const secs = raw.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
    return secs.slice(-days).join('\n\n');
  } catch { return ''; }
}

function readRawTail(key, n = CFG.rawTailMsgs ?? 6) {
  return archiveLines(key)
    .slice(-n)
    .map((l) => {
      try {
        const o = JSON.parse(l);
        return `${o.role === 'me' ? '我' : '主人'}: ${String(o.text).replace(/\n/g, ' ').slice(0, 200)}`;
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

// 每轮开口带的记性：底账 + 最近三天日子账 + 今天小结 + 最近几句原话
// 2026-10-18 拆成四块分开取（memoryParts），好让拼装时把稳定的放前面、会变的贴到原话旁边。
function memoryParts(key, query = '') {
  ensureBase(key);
  const base = readBase(key);
  const ledger = readLedgerRecent(key);
  const today = logicalDay();
  const short = readShort(key, today);
  // 群里主人常连着说几句才 @ 我一次，尾巴要长一点才接得住前文；私聊还是只带最近几句。
  const tailN = key.startsWith('group:') ? (CFG.groupRawTailMsgs ?? 40) : (CFG.rawTailMsgs ?? 6);
  const tail = readRawTail(key, tailN);
  // 旧账检索：有原话才查，太短的「嗯」「好」不查（省一次全盘扫描，也免得塞噪音）
  let retrieved = '';
  const q = String(query ?? '').replace(/\[CQ:[^\]]*\]/g, ' ').trim();
  if (CFG.memoSearch !== false && q.length >= 4) {
    try {
      const hit = retrieveMemo(CFG.home, q, { limit: 3, maxChars: 800 });
      if (hit) retrieved = '[旧账检索 · 只是参考，不是事实来源；答之前回档案页核，对不上就直说没查到]\n' + hit;
    } catch (e) {
      log(`旧账检索失败（不影响这轮）：${e?.message ?? e}`);
    }
  }
  return {
    base: base ? '[长期底账 · 我是谁、规矩、答应他的事；这本不动]\n' + base : '',
    retrieved,
    ledger: ledger ? '[日子账 · 最近几天；更早的留在硬盘上，要用再去翻]\n' + ledger : '',
    short: short ? `[今天（${today}）到目前为止]\n` + short : '',
    tail: tail ? '[最近几句原话]\n' + tail : '',
    today,
  };
}

// 老样子的一块（--memory-dump 用，也是没拆之前的原样）
function memoryBlock(key) {
  const m = memoryParts(key);
  return [m.base, m.ledger, m.short, m.tail].filter(Boolean).join('\n\n');
}

// ---------- 事件卡（2026-10-18 接进本体：一件事一张，四点结账从卡里挑要点） ----------
// 位置：archive\days\<key>\<YYYY-MM-DD>\<时-分>-<一句话>.md
// 只记主人亲口说的，不花模型钱：一句话取他那句的原话头，不推断心思、不加评论。
// 纯闲聊、表情包、一两个字的应答不写卡；同一天同名卡往后补原话，不再开第二张。
const DAYS_DIR = path.join(ARCHIVE_DIR, 'days');
const CARD_MAX_PER_DAY = 80;
const CARD_MIN_CHARS = 12;

function cardDayDir(key, day) {
  return path.join(DAYS_DIR, archiveKey(key), day);
}

// 群里的话带到本体时前面挂着「[群里 … 说] 」，卡片里不要那截
function stripGroupPrefix(text) {
  return String(text ?? '').replace(/^\[群里 [^\]]*\]\s*/, '').trim();
}

function cardQuote(text) {
  return stripGroupPrefix(text)
    .replace(/\[CQ:[^\]]*\]/g, '')
    // 只发图/语音/文件时本体塞进来的占位，不是他的话，别记进卡
    .replace(/\[(图片已存到本机|语音|视频|图片|文件|表情)[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function cardTitle(text) {
  const one = cardQuote(text);
  const head = one.split(/[。！？!?；;\n]/)[0] || one;
  let core = head;
  if (core.length > 24) {
    // 长句先按逗号收，别把标题切在半句话上；实在没逗号才硬截
    const fit = head
      .split(/[，,、]/)
      .reduce((acc, c) => (acc.length + c.length + 1 <= 24 ? acc + (acc ? '，' : '') + c : acc), '');
    core = fit.length >= 8 ? fit : head.slice(0, 24);
  }
  const cut = core.replace(/[\\/:*?"<>|\s]+/g, ' ').trim().replace(/[.，,、 ]+$/, '');
  return cut || '随手一句';
}

function shouldCard(text) {
  const t = cardQuote(text);
  if (t.replace(/[\s\p{P}\p{S}]/gu, '').length < CARD_MIN_CHARS) return false;
  if (/^(嗯+|哦+|噢+|好+|行+|好吧|可以|收到|在吗|在不在|你好|哈哈+|嘿嘿|草|艹|6|？+|\?+)[~～。.!！?？]*$/.test(t)) return false;
  return true;
}

function cardFileTime(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
}

function writeEventCard(key, text, opts = {}) {
  try {
    const raw = cardQuote(text);
    if (!raw) return null;
    if (!opts.force && !shouldCard(raw)) return null;
    const day = opts.day ?? logicalDay();
    const dir = cardDayDir(key, day);
    fs.mkdirSync(dir, { recursive: true });
    const title = cardTitle(raw);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (files.length >= CARD_MAX_PER_DAY) return null;
    const hit = files.find((f) => f.endsWith(`-${title}.md`));
    if (hit) {
      const p = path.join(dir, hit);
      const old = fs.readFileSync(p, 'utf8');
      const quotes = old.split('\n').filter((l) => l.startsWith('- 「')).length;
      if (old.includes(`- 「${raw}」`) || quotes >= 8) return p;
      fs.appendFileSync(p, `- 「${raw}」\n`, 'utf8');
      return p;
    }
    const stamp = opts.stamp ?? cardFileTime();
    const where = key.startsWith('group:') ? `群 ${key.slice('group:'.length)}` : 'QQ';
    const body = [
      `日期：${day}`,
      `来处：${where}`,
      `一句话：${title}`,
      '原话：',
      `- 「${raw}」`,
      '',
    ].join('\n');
    let file = path.join(dir, `${stamp}-${title}.md`);
    if (fs.existsSync(file)) file = path.join(dir, `${stamp}-${title}-${files.length + 1}.md`);
    fs.writeFileSync(file, body, 'utf8');
    log(`事件卡已写：${path.relative(ARCHIVE_DIR, file)}`);
    return file;
  } catch (e) {
    log('写事件卡失败:', e?.message ?? String(e));
    return null;
  }
}

// 四点结账时读这天的卡：一句话 + 最多三条原话，当抓手不当正文
function readDayCards(key, day, max = 40) {
  try {
    const dir = cardDayDir(key, day);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-max);
    return files
      .map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const title = (raw.match(/^一句话：(.+)$/m) ?? [])[1] ?? f.replace(/\.md$/, '');
        const quotes = raw.split('\n').filter((l) => l.startsWith('- 「')).slice(0, 3);
        return `- ${f.slice(0, 5)} ${title}\n${quotes.map((q) => '  ' + q).join('\n')}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

const SHORT_PROMPT = (oldShort, freshLines) =>
  [
    '[系统安排 · 不是主人在说话]',
    '[把「今天到目前为止」的小结跟下面这段新对话合成一份新小结；这是滚动小结，旧的整份会被这份替换。]',
    '[只留今天的事：他在做什么、聊到的事、他答应过什么、还欠着什么、我这边的状态。身份和长期规矩不要写进来（底账里有）。]',
    '[直接用要点原文回复我：最多 8 条，每条一行，以 "- " 开头；不要写文件、不要解释、不要带日期标题。]',
    '[旧小结：]',
    oldShort || '(空)',
    '[新对话：]',
    freshLines.join('\n'),
  ].join('\n');

// 攒够 N 条就把「今天到目前为止」压一次；只动短期，不碰底账和日子账
async function maybeSummarize(key) {
  if (!isStateless()) return;
  if (summarizing.has(key)) return; // 已经有一次在压了，别重复烧钱
  ensureBase(key);
  const day = logicalDay();
  const meta = readMeta(key);
  if ((meta.shortDay ?? day) !== day) return; // 还没换日结账，原话先攒着
  if (isPeakHour()) return; // [谷时压缩] 高峰只攒不压，等谷时批量压
  if (unsummarized(key) < (CFG.summaryEveryMsgs ?? 20)) return;
  summarizing.add(key);
  try {
    const lines = archiveLines(key);
    const from = meta.summarizedLines ?? 0;
    // 群里的旁听消息不逐条回，可能一攒很多；只压最近 120 条，旧的原话留在档案里，
    // 别让一次小结把整段历史全塞进一轮（烧钱也容易超时）。
    const fresh = lines
      .slice(from)
      .slice(-120)
      .map((l) => {
        try {
          const o = JSON.parse(l);
          return `${o.role === 'me' ? '我' : '主人'}: ${String(o.text).slice(0, 300)}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    if (!fresh.length) return;
    const r = await runQueuedTask(key, 'summary', SHORT_PROMPT(readShort(key, day), fresh), { withMemory: false });
    if (!r.ok) {
      log('压当天小结没成功，下次再试:', r.error);
      return;
    }
    fs.writeFileSync(shortPath(key), r.text.trim() + '\n', 'utf8');
    writeJson(metaPath(key), { ...meta, summarizedLines: lines.length, shortDay: day, updatedAt: Date.now() });
    log(`当天小结已更新：${fresh.length} 条新对话 -> ${path.basename(shortPath(key))}`);
  } catch (e) {
    log('写当天小结失败:', e?.message ?? String(e));
  } finally {
    summarizing.delete(key);
  }
}

const CLOSE_PROMPT = (day, short, freshLines, cards = '') => {
  const parts = [
    '[系统安排 · 不是主人在说话]',
    `[这一天要收进「日子账」了（${day}）。把下面这些压成 3 到 5 条要点：]`,
    '[只留以后还用得上的：他做了什么、答应了什么、还欠着什么、有什么新情况；我的状态最多一句，别写客套话。]',
    '[直接用要点原文回复我：3 到 5 行，每行以 "- " 开头；不要日期标题、不要解释、不要写文件。]',
    '[当天小结：]',
    short || '(空)',
  ];
  // 有事件卡就从卡里挑（一天一件事一张，比整段聊天好挑）；没卡才退回原话尾巴
  if (cards) {
    parts.push('[当天的事件卡（一件事一张；挑要点从这儿挑，别编卡里没有的事）：]');
    parts.push(cards);
  } else {
    parts.push('[还没进小结的原话：]');
    parts.push(freshLines.join('\n') || '(空)');
  }
  return parts.join('\n');
};

// 换日结账：把上一天的小结（加少量还没进小结的原话）压成 3-5 条，接进日子账。
// 那天没聊过就不结、不花模型钱；失败留半小时冷却，别十分钟一次空转。
async function rollDay(key) {
  if (!isStateless()) return false;
  ensureBase(key);
  const today = logicalDay();
  const meta = readMeta(key);
  if (!meta.shortDay) {
    writeJson(metaPath(key), { ...meta, shortDay: today, summarizedLines: meta.summarizedLines ?? 0, updatedAt: Date.now() });
    return false;
  }
  if (meta.shortDay === today) return false;
  if (meta.closeFailAt && Date.now() - meta.closeFailAt < 30 * 60 * 1000) return false;

  const oldDay = meta.shortDay;
  const start = logicalDayStart(oldDay);
  const end = logicalDayStart(today);
  const all = archiveLines(key);
  let consumed = 0;
  const fresh = [];
  all.forEach((line, idx) => {
    try {
      const o = JSON.parse(line);
      if (!(o.ts >= start && o.ts < end)) return;
      consumed = idx + 1;
      if (idx >= (meta.summarizedLines ?? 0)) {
        fresh.push(`${o.role === 'me' ? '我' : '主人'}: ${String(o.text).replace(/\n/g, ' ').slice(0, 200)}`);
      }
    } catch {
      /* 坏行跳过 */
    }
  });
  let short = '';
  try { short = fs.readFileSync(shortPath(key), 'utf8').trim(); } catch { /* 没小结也照结 */ }
  const freshTail = fresh.slice(-120); // 兜底上限：真积压了也只喂最后一截
  const cards = readDayCards(key, oldDay); // 事件卡：有就按卡挑要点，不回头重读整段聊天

  if (!short && !freshTail.length && !cards) {
    writeJson(metaPath(key), { ...meta, shortDay: today, summarizedLines: Math.max(meta.summarizedLines ?? 0, consumed), updatedAt: Date.now() });
    log(`换日：${oldDay} 没聊过，不结账`);
    return false;
  }

  // 两条巡检路（换日 / 谷时压缩）可能同时到，同一会话只允许一个在结账
  if (rolling.has(key)) return false;
  rolling.add(key);
  try {
    const r = await runQueuedTask(key, 'ledger', CLOSE_PROMPT(oldDay, short, freshTail, cards), { withMemory: false });
    if (!r.ok) {
      writeJson(metaPath(key), { ...meta, closeFailAt: Date.now(), updatedAt: Date.now() });
      log('日子账没结成，半小时后再试:', r.error);
      return false;
    }
    const bullets = r.text
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^[-·•]\s*\S/.test(s))
      .slice(0, 6);
    if (!bullets.length) {
      writeJson(metaPath(key), { ...meta, closeFailAt: Date.now(), updatedAt: Date.now() });
      log('日子账没结成（回复里没有要点），半小时后再试');
      return false;
    }
    try {
      fs.appendFileSync(ledgerPath(key), `\n## ${oldDay}\n${bullets.join('\n')}\n`, 'utf8');
      fs.writeFileSync(shortPath(key), '', 'utf8');
    } catch (e) {
      log('写日子账失败:', e?.message ?? String(e));
      return false;
    }
    writeJson(metaPath(key), { shortDay: today, summarizedLines: Math.max(meta.summarizedLines ?? 0, consumed), updatedAt: Date.now() });
    log(`换日结账：${oldDay} -> 日子账 ${bullets.length} 条；今天 ${today} 重新起头`);
    return true;
  } finally {
    rolling.delete(key);
  }
}

// 巡所有开过账的会话（2026-10-17 开群后从"只巡主会话"放开）：私聊和群各结各的
async function rollAllDays() {
  let keys = [PRIMARY_KEY];
  try {
    keys = fs.readdirSync(ARCHIVE_DIR)
      .filter((n) => n.endsWith('.meta.json'))
      .map((n) => n.slice(0, -'.meta.json'.length));
  } catch { /* 目录读不了就只结主会话 */ }
  for (const k of keys) {
    try {
      await rollDay(k);
    } catch (e) {
      log('换日巡检异常:', k, e?.message ?? String(e));
    }
  }
}

// ---------- 每周自检（周日晚上问三句；本地拼句子，不花模型钱） ----------
const PAGE_DIR = path.join(CFG.home, '档案');
const PAGE_LOG_PATH = path.join(PAGE_DIR, '_翻页记录.json');

function readPageLog() {
  try {
    const raw = fs.readFileSync(PAGE_LOG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function pageRows() {
  let files = [];
  try {
    files = fs.readdirSync(PAGE_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && /^[A-Z]\d*[-_— ].+\.md$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const log = readPageLog() ?? {};
  const since = log._since?.last ? Date.parse(log._since.last) : null;
  const index = readBase(PRIMARY_KEY);
  const now = Date.now();
  return files.map((name) => {
    const rec = log[name];
    const lastMs = rec?.last ? Date.parse(rec.last) : since;
    const days = Number.isFinite(lastMs) ? Math.floor((now - lastMs) / 86400000) : null;
    return {
      name,
      label: name.replace(/\.md$/, '').replace(/^([A-Z]\d*)[-_— ]/, '$1 '),
      days,
      opened: Boolean(rec?.last),
      inIndex: index.includes(name),
    };
  });
}

function weeklyCheckText() {
  const rows = pageRows();
  if (!rows.length) return '';
  const cold = rows.filter((r) => r.days !== null && r.days >= 7);
  const stale = rows.filter((r) => r.days !== null && r.days >= 30);
  const missing = rows.filter((r) => !r.inIndex);
  const parts = ['周日自检，问三句：'];
  if (cold.length) {
    parts.push(`- 这周没翻的：${cold.map((r) => (r.opened ? `${r.label}（${r.days} 天）` : `${r.label}（从没翻过）`)).join('、')}`);
  } else {
    parts.push('- 这周该翻的都翻过了，没冷页。');
  }
  parts.push(stale.length
    ? `- 该沉底的：${stale.map((r) => r.label).join('、')}，你说挪我就挪。`
    : '- 还没有到 30 天该沉底的。');
  parts.push(missing.length
    ? `- 索引里没挂的：${missing.map((r) => r.label).join('、')}，要补一行吗？`
    : '- 索引没漏。');
  // 会变的数（余额这类）：钱页超过两天没更就提一句，别让旧数字待在账上
  try {
    const b = rows.find((r) => /^B/.test(r.name));
    if (b) {
      const st = fs.statSync(path.join(PAGE_DIR, b.name));
      const d = Math.floor((Date.now() - st.mtimeMs) / 86400000);
      if (d >= 2) parts.push(`- 钱页 ${d} 天没更了，余额那行还作数吗？`);
    }
  } catch {
    /* 读不到就算了，不为这一句卡住自检 */
  }
  return parts.join('\n');
}

async function maybeWeeklyCheck() {
  const { day, hour } = bjParts();
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  if (bj.getUTCDay() !== 0) return; // 只周日
  if (hour < 20) return; // 晚上八点以后再说
  if (state.weeklyCheckDay === day) return; // 今天问过了
  if (pauseMode() !== 'off') return;
  if (!wsReady) return;
  const text = weeklyCheckText();
  if (!text) return;
  await reply('private', CFG.allowlist[0], text);
  state.weeklyCheckDay = day;
  saveState();
  log('每周自检已发出：', text.replace(/\n/g, ' ').slice(0, 120));
}

// ---------- [谷时压缩] ----------
// 高峰（北京时间周一至周五 9:00-12:00、14:00-18:00）单价翻倍，压小结又最费 token，
// 所以：高峰只攒不压，谷时（含周末、节假日）补一次。
// 只巡主会话：群聊关着（2026-10-16 主人让关），以后开了群再把群键加进来。
const summarizing = new Set(); // 正在压小结的会话，防两条路同时压同一个

function isPeakHour(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const wd = d.getUTCDay(); // 0 = 周日
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (wd === 0 || wd === 6) return false;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// 谷时补压：先换日结账，再看主会话积压够不够
async function batchCompress() {
  if (!isStateless()) return;
  if (isPeakHour()) return; // 还在高峰，继续攒
  await rollDay(PRIMARY_KEY);
  if (unsummarized(PRIMARY_KEY) < (CFG.summaryEveryMsgs ?? 20)) return;
  if (summarizing.has(PRIMARY_KEY)) return;
  log(`[谷时压缩] 积压 ${unsummarized(PRIMARY_KEY)} 条，补压当天小结`);
  await maybeSummarize(PRIMARY_KEY);
}

// ---------- 会话与队列 ----------
const queues = new Map();
const rateWindow = [];

function conversationKey(msg) {
  return msg.message_type === 'group' ? `group:${msg.group_id}` : `private:${msg.user_id}`;
}

function enqueue(key, item) {
  let q = queues.get(key);
  if (!q) {
    q = { running: false, items: [] };
    queues.set(key, q);
  }
  q.items.push(item);
  if (!q.running) void drain(key);
}

async function drain(key) {
  const q = queues.get(key);
  if (!q) return;
  q.running = true;
  while (q.items.length > 0) {
    const item = q.items.shift();
    try {
      const result = await handleOne(key, item);
      item.__resolve?.(result);
    } catch (e) {
      log('队列处理异常:', e?.message ?? String(e));
      item.__resolve?.({ ok: false, error: e?.message ?? String(e) });
      try {
        await reply(item.kind, item.target, '诶，我这边出了点岔子，等下再试一次？');
      } catch {
        /* ignore */
      }
    }
  }
  q.running = false;
}

// 每轮的提示头。同步文件一更新，就多给一行"明确叫它读"的指令（软提示它不会主动读，实测过）。
// 2026-10-18 前缀缓存重排：拆成两截——固定行（每轮一字不差）+ 会变的行（同步提醒、当前时间、语音说明、说话标记）。
// 固定的放大段前面，会变的贴着用户原话，这样 DeepSeek 的前缀缓存每轮都能吃到那一段。
const STYLE_FIXED_LINES = [
  `[QQ 会话 · 开口前先读 ${CFG.home}\\_回复风格.md；要记备忘或定提醒时读 ${CFG.home}\\_备忘与提醒.md]`,
];

// dry=true：只拼不记账（预览用，别把"新同步"这条提醒吃掉）
function styleParts(dry = false, key = '') {
  const fixed = STYLE_FIXED_LINES.join('\n');
  const volatile = [];
  try {
    const st = fs.statSync(CFG.syncOut);
    if (st.mtimeMs > (state.syncToldAt ?? 0)) {
      volatile.push(`[DSH 那边有新对话：先用 read 工具看一眼 ${CFG.syncOut} 再回话。]`);
      if (!dry) {
        state.syncToldAt = st.mtimeMs;
        saveState();
      }
    }
  } catch {
    /* 同步文件还没生成就算了 */
  }
  if (key === PRIMARY_KEY && kitNamePending()) volatile.push(kitNameLine());
  volatile.push(`[当前时间：${nowInBeijing()}（北京时间）]`);
  // 语音（2026-10-16 晚上通的路）：想说人话的时候，把话写在 [语音]…[/语音] 里，本体合成成 QQ 语音发出去。
  // 规矩：默认不用语音；主人明说了"用语音回/说句话给我听"才用。一条回复最多两段，每段控制在一两句话（60 秒上限）。
  // 语音标记之外还要留一句文字，别整条回复只有语音。
  if (CFG.voiceEnabled) {
    volatile.push('[语音：这一条如果该用声音说，就把要说的话单独写成 [语音]…[/语音]（最多两段、每段一两句）；主人没要求就用文字，别自己加。]');
  }
  volatile.push('[主人通过 QQ 说：]');
  return { fixed, volatile: volatile.join('\n') };
}

// 原来的整块（--selftest 和对比用）：固定行 → 会变的行
function styleHeader() {
  const { fixed, volatile } = styleParts();
  return `${fixed}\n${volatile}`;
}

// 每轮的完整提示（2026-10-18 定下的顺序，从前往后）：
//   固定说明 → 我记着的事（底账 / 日子账 / 当天小结）→ 同步提醒+时间+语音+说话标记 → 用户原话 → 最近几句原话
// 原则：稳定的在前，每轮变的在后；各块文字保持原样，只动拼接位置。
const MEMORY_LABEL = '[我记着的事（开口前先认这个；底账里的规矩别忘）：]';
function buildTurnPrompt(key, text, opts = {}) {
  const mem = isStateless() && opts.withMemory !== false ? memoryParts(key, text) : null;
  const parts = [];
  if (opts.withHeader === true) {
    const { fixed, volatile } = styleParts(Boolean(opts.dry), key);
    parts.push(fixed);
    if (mem) parts.push(MEMORY_LABEL, mem.base, mem.retrieved, mem.ledger, mem.short);
    parts.push(volatile, text);
  } else {
    // 内部任务（主动搭话、写日记）没有提示头：记性照样放前面，指令贴后面
    if (mem) parts.push(MEMORY_LABEL, mem.base, mem.retrieved, mem.ledger, mem.short);
    parts.push(text);
  }
  if (mem?.tail) parts.push(mem.tail);
  return parts.filter(Boolean).join('\n');
}

// 主会话键（私聊主人）。主动搭话、写日记都针对这一条会话。
const PRIMARY_KEY = `private:${CFG.allowlist[0]}`;

// ---------- 主动搭话 ----------
const PING_PROMPT = [
  '[系统安排 · 不是主人在说话]',
  '[主人已经有一阵子没吭声了。用你自己的口吻主动跟他搭一句话，1-2 句就够：]',
  '[可以提你刚想起的事、或单纯问一句在干嘛；别复述这条说明、别问"需要什么帮助"。]',
].join('\n');
// 平时盲搭：这一轮不许动工具（省一轮的钱，也免得它翻本子翻半天）
const PING_NO_TOOLS = '[这一轮不要调用任何工具。]';
// 偷看过屏幕的这一轮：放开"看一眼图"这一个动作，别的还是不许动
const PING_PEEK = [
  '[出门前我顺手截了一张他屏幕的图，就在下面这个路径：__SHOT__]',
  '[先看一眼（用看图工具读这个文件）再开口：看得懂他在干嘛就说得具体一点；看不懂、或者画面里有私密的东西，就当没看见，照常随口问一句。]',
  '[别跟他说"我看了你的屏幕"，也别念路径。这一轮只准读这张图，别动别的工具。]',
].join('\n');

async function maybeProactivePing() {
  const a = (state.activity[PRIMARY_KEY] ??= { lastUserAt: Date.now(), pingsDay: bjDayKey(), pings: 0 });
  const now = Date.now();
  const { day, hour } = bjParts(now);
  // 计时口径：从"我们最后一次对话"算——他说的、我说的都算（主人 2026-10-18 15:43 定的）
  const idleMs = now - a.lastUserAt;
  if (pauseMode() !== 'off') return; // 暂停开关开着，先不主动搭话

  // 夜里不吵：原来 23 点到早 9 点一律闭嘴。主人 2026-10-17 15:31 说
  // 「半夜可以说话，但是半夜我没法及时回」，15:32 又说「改吧」——所以 23 点到凌晨 2 点放开，
  // 凌晨 2 点到早 9 点照旧不吵他睡觉。
  if (hour >= 2 && hour < 9) return;
  const deepNight = hour >= 23;
  // 谷时限定（主人 2026-10-16 19:30 要求"主动找我说话限定谷时"）：
  // 工作日 9-12、14-18 单价翻倍，这两段一律不主动开口（私聊回复不受影响）；
  // 剩下能搭话的窗口 = 工作日 12-14、18-次日 2，周末 9-次日 2（周末本来就不算高峰）。
  if (isPeakHour(now)) return;
  // 主人 2026-10-18 17:0x：「从我们最后一句算起，先安静半小时，然后到满两小时之间
  // 随机冒一次；满两小时还没冒，就重新开始掷骰子，如果这个期间发起对话之后我还没回，就安静」。
  if (idleMs < CFG.idlePingMinMs) return; // 半小时内绝不冒头
  if (a.pingedForIdleAt && a.pingedForIdleAt > a.lastUserAt) return; // 这一轮搭过了他没回 → 安静，别追
  if (a.pingsDay !== day) {
    a.pingsDay = day;
    a.pings = 0;
    saveState();
  }
  // 每一轮冷场抽一个随机时刻，落在"最后一句 + 30 分钟"到"最后一句 + 2 小时"之间
  const planFor = a.lastUserAt;
  const span = CFG.idlePingWindowMs - CFG.idlePingMinMs;
  if (a.pingPlanFor !== planFor || typeof a.pingAt !== 'number') {
    a.pingPlanFor = planFor;
    a.pingAt = planFor + CFG.idlePingMinMs + Math.random() * span;
    saveState();
  }
  // 满两小时还没冒出来（多半是被高峰或深夜挡掉了）：重新开始掷骰子，再抽一轮
  if (now >= planFor + CFG.idlePingWindowMs) {
    a.pingAt = now + CFG.idlePingMinMs + Math.random() * span;
    saveState();
    return;
  }
  if (now < a.pingAt) return;

  log(`主人已安静 ${(idleMs / 3600000).toFixed(1)} 小时，准备主动搭一句话`);
  // 偷看一眼屏幕（2026-10-19 主人点头）：只在真要开口的这一跳截，不另开定时器；
  // 截到了就把路径交给模型自己看，截不到就盲搭。发完立刻删，不攒图。
  let shot = null;
  if (Math.random() < CFG.peekChance) {
    shot = await grabScreen();
    if (shot) log(`偷看了一眼屏幕（${Math.round(fs.statSync(shot).size / 1024)}KB）`);
  }
  const base = deepNight
    ? PING_PROMPT + '\n[现在是深夜，他大概躺着刷手机。轻声说一句就好，别问问题、别催他回。]'
    : PING_PROMPT;
  const prompt = shot ? `${base}\n${PING_PEEK.replace('__SHOT__', shot)}` : `${base}\n${PING_NO_TOOLS}`;
  const r = await runQueuedTask(PRIMARY_KEY, 'ping', prompt);
  if (shot) {
    try {
      fs.unlinkSync(shot);
    } catch {
      /* 删不掉也无所谓，下次拍之前还会清一遍 */
    }
  }
  if (!r.ok) {
    log('主动搭话没生成成功，跳过这次:', r.error);
    return;
  }
  await reply('private', CFG.allowlist[0], r.text);
  // 注意：这句不推 lastUserAt。推了的话这一轮就算"刚聊完"，
  // 半小时后又能冒一次，整晚每隔一小时一句——变成刷屏。一轮只搭一次，等他开口再重新起算。
  a.pingedForIdleAt = now;
  a.pings += 1;
  state.activity[PRIMARY_KEY] = a;
  saveState();
  log(`已主动搭话（今天第 ${a.pings} 次）: ${r.text.slice(0, 60).replace(/\n/g, ' ')}`);
}

// ---------- 日记 ----------
const DIARY_PROMPT = (day) =>
  [
    '[系统安排 · 不是主人在说话]',
    `[现在是 ${day} 深夜。把今天跟主人聊的要事写成一篇要事记录，追加到 ${CFG.home}\\要事.md：]`,
    `[格式：以 "## ${day}" 开头，下面 3-6 条短横线要点，写今天做了什么、进度到哪、欠着什么；别编没发生的事。]`,
    '[写完只用一句话跟我交差，不要复述日记内容。]',
  ].join('\n');

async function maybeWriteDiary() {
  const now = Date.now();
  const { day, hour, minute } = bjParts(now);
  if (hour < 23) return;
  if (hour === 23 && minute < 30) return;
  const a = (state.activity[PRIMARY_KEY] ??= { lastUserAt: now, pingsDay: day, pings: 0 });
  if (a.diaryDay === day) return;
  if (pauseMode() !== 'off') return; // 暂停开关开着，先不写日记

  log(`开始写 ${day} 的日记`);
  const r = await runQueuedTask(PRIMARY_KEY, 'diary', DIARY_PROMPT(day));
  if (!r.ok) {
    log('日记没写成，明天再试:', r.error);
    return; // 不记 diaryDay，下一轮还会再试
  }
  a.diaryDay = day;
  saveState();
  log('日记已写:', r.text.slice(0, 80).replace(/\n/g, ' '));
}

// 统一的一轮执行：负责会话续接、失败重试、写回 sessionId。
// 返回 { ok, text, error }；不发消息——发不发由调用方决定（用户消息要发，内部任务不一定）。
async function runTurn(key, prompt, opts = {}) {
  // 无状态模式（stateless.flag 存在时）：不带会话历史，改成带上「底账 + 日子账 + 当天小结 + 原话尾巴」
  // 压小结 / 结日子账这种内部任务用 withMemory:false：它们自己就带着要处理的原文，别让记性再叠一遍。
  // 拼装顺序在 buildTurnPrompt()：稳定的在前，会变的在后（前缀缓存）。
  const stateless = isStateless();
  const full = buildTurnPrompt(key, prompt, { withMemory: opts.withMemory, withHeader: opts.withHeader });
  const sessionId = stateless ? null : (state.sessions[key] ?? null);
  const started = Date.now();
  const used = { input: 0, output: 0, cache: 0, total: 0 };
  let steps = 0;
  let attempts = 0;
  const soak = (r) => {
    attempts += 1;
    steps += r?.steps ?? 0;
    const u = r?.usage ?? {};
    for (const k of Object.keys(used)) used[k] += Number(u[k]) || 0;
  };
  let res = await runWhale(full, sessionId);
  soak(res);

  if (!res.ok && sessionId && /session/i.test(`${res.stderr ?? ''} ${res.error ?? ''}`)) {
    log(`会话 ${sessionId} 不可用，丢弃并开新会话重试`);
    delete state.sessions[key];
    saveState();
    res = await runWhale(full, null);
    soak(res); // 重试那次也是花了钱的，一起记账
  }

  if (res.sid && res.sid !== state.sessions[key]) {
    state.sessions[key] = res.sid;
    saveState();
  }

  const ms = Date.now() - started;
  if (!res.ok) return { ok: false, error: res.error, stderr: res.stderr, ms, usage: used, steps, attempts, sid: res.sid ?? null };
  return { ok: true, text: res.text, ms, usage: used, steps, attempts, sid: res.sid ?? null, reason: res.reason };
}

async function handleOne(key, item) {
  // 内部任务（主动搭话、写日记、压小结、结日子账）：不发消息、不计入"刚有互动"
  if (item.mode === 'task') {
    const r = await runTurn(key, item.prompt, { withMemory: item.withMemory !== false });
    log(`内部任务 ${item.kind}：${r.ok ? 'ok' : '失败 ' + r.error}（${(r.ms / 1000).toFixed(1)}s）`);
    logTurn({
      key,
      kind: `task:${item.kind}`,
      ok: r.ok,
      ms: r.ms,
      chars: r.text?.length ?? 0,
      steps: r.steps,
      attempts: r.attempts,
      tokens: r.usage,
      reason: r.reason,
      error: r.ok ? undefined : r.error,
      sid: r.sid,
    });
    return r;
  }

  // 群里的旁听消息：只进档案当上下文，不回、不叫模型，也不花一轮的钱。
  // 顺手把群会话的 meta 起好，这样凌晨四点也会像私聊一样给它结日子账。
  if (item.mode === 'ambient') {
    noteUserActivity();
    appendArchive(key, 'user', item.text);
    ensureBase(key);
    const meta = readMeta(key);
    if (!meta.shortDay) {
      writeJson(metaPath(key), {
        ...meta,
        shortDay: logicalDay(),
        summarizedLines: meta.summarizedLines ?? 0,
        updatedAt: Date.now(),
      });
    }
    log(`群里没叫我，已收进上下文（${key}）: ${item.text.slice(0, 60)}`);
    return { ok: true };
  }

  const { kind, target, sender, text } = item;
  noteUserActivity();
  appendArchive(key, 'user', text);
  callAction('set_input_status', { user_id: sender, event_type: 1 }).catch(() => {});
  // 提示头、记性、原话尾巴都由 runTurn 里的 buildTurnPrompt 按固定顺序拼，这里只递他的原话。
  const r = await runTurn(key, text, { withHeader: true });

  if (!r.ok) {
    log('这一轮没答上来:', r.error, r.stderr ?? '');
    logTurn({
      key,
      kind,
      ok: false,
      ms: r.ms,
      chars: 0,
      steps: r.steps,
      attempts: r.attempts,
      tokens: r.usage,
      error: r.error,
      sid: r.sid,
    });
    await reply(kind, target, r.error);
    return r;
  }

  log(`回复 ${key}（${(r.ms / 1000).toFixed(1)}s，${r.text.length} 字，${r.usage?.total ?? 0} token）: ${r.text.slice(0, 80).replace(/\n/g, ' ')}`);
  logTurn({
    key,
    kind,
    ok: true,
    ms: r.ms,
    chars: r.text.length,
    steps: r.steps,
    attempts: r.attempts,
    tokens: r.usage,
    reason: r.reason,
    sid: r.sid,
  });
  await reply(kind, target, r.text);
  appendArchive(key, 'me', r.text);
  // 主动搭话的计时按"我们最后一次对话"算：我回的这句也算（主人 2026-10-18 15:43 定的）
  if (kind === 'private' && Number(sender) === CFG.allowlist[0]) noteUserActivity();
  // 他亲自说的、够得上"一件事"的，落一张事件卡（本地写，不花模型钱；群里别人的话不写）
  if (CFG.allowlist.includes(Number(sender))) writeEventCard(key, text);
  void maybeSummarize(key);
  return r;
}

// 把一个内部任务排进指定会话的队列，等它跑完拿结果（与用户消息严格串行，不会抢同一个 session）
function runQueuedTask(key, kind, prompt, opts = {}) {
  return new Promise((resolve) => {
    enqueue(key, { mode: 'task', kind, prompt, withMemory: opts.withMemory, __resolve: resolve });
  });
}

// ---------- 提醒 ----------
// 已武装的提醒 id：扫描是周期性的，同一 id 只能武装一次，否则到点会重复发送（踩过：一条提醒连发 3 次）。
const armedReminders = new Set();

function dropReminder(id) {
  const cur = readJson(REMINDERS_PATH, []);
  if (Array.isArray(cur)) writeJson(REMINDERS_PATH, cur.filter((x) => x.id !== id));
}

function fireReminder(r, why) {
  // 睡眠/休眠会让 setTimeout 在醒来时补跑；超过 10 分钟就不补了，跟启动扫描的口径一致。
  const at = Date.parse(r.at);
  if (why === '定时' && Number.isFinite(at) && Date.now() - at > 10 * 60 * 1000) {
    log('提醒过期太久，丢弃:', r.content);
    dropReminder(r.id);
    armedReminders.delete(r.id);
    return;
  }
  const to = r.toUser ?? CFG.allowlist[0];
  reply('private', to, r.content).catch((e) => log('提醒发送失败:', e.message));
  dropReminder(r.id);
  armedReminders.delete(r.id);
  log('发出提醒:', why, r.content);
}

function scheduleReminders() {
  const list = readJson(REMINDERS_PATH, []);
  if (!Array.isArray(list) || list.length === 0) return;
  const now = Date.now();
  for (const r of list) {
    if (armedReminders.has(r.id)) continue; // 已武装过，别再排一个
    const at = Date.parse(r.at);
    if (Number.isNaN(at)) {
      log('提醒时间无法解析，移除:', JSON.stringify(r));
      dropReminder(r.id);
      continue;
    }
    const delay = at - now;
    if (delay <= 0) {
      if (now - at < 10 * 60 * 1000) fireReminder(r, '到点');
      else {
        log('提醒过期太久，丢弃:', r.content);
        dropReminder(r.id);
      }
      continue;
    }
    if (delay < 2 ** 31 - 1) {
      armedReminders.add(r.id);
      setTimeout(() => fireReminder(r, '定时'), delay);
    }
  }
}

// ---------- 准入 ----------
function extractText(msg) {
  const segs = msg.message;
  if (typeof segs === 'string') return segs;
  if (Array.isArray(segs)) {
    return segs
      .filter((s) => s.type === 'text')
      .map((s) => s.data?.text ?? '')
      .join('')
      .trim();
  }
  return '';
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// 只给日志用的"这条大概是什么"摘要（2026-10-16 加）：白名单闸挪到最前面之后，被丢掉的消息不再走
// buildIncoming，所以这里得自己认一眼类型。纯看消息段类型，不下载图、不转写语音、不落任何盘。
function describeSegments(msg) {
  const segs = msg?.message;
  const out = [];
  let texts = 0;
  for (const seg of Array.isArray(segs) ? segs : []) {
    switch (seg?.type) {
      case 'text': texts++; break;
      case 'image': out.push('图片'); break;
      case 'mface': out.push('表情包'); break;
      case 'record': out.push('语音'); break;
      case 'video': out.push('视频'); break;
      case 'file': out.push('文件'); break;
      case 'forward': out.push('合并转发'); break;
      case 'json':
      case 'xml': out.push('卡片'); break;
      case 'face': out.push('QQ表情'); break;
      default: break;
    }
  }
  if (texts) out.unshift(`文字${texts}段`);
  return out.join('+') || '(空)';
}

// 群里没叫我时，只把"说了什么"记进上下文：文字照收，图/语音只留占位，
// 不下载、不转写、不花模型钱（2026-10-17 主人说"你在群里说的话都收进来当上下文"）。
function ambientText(msg) {
  const segs = Array.isArray(msg.message) ? msg.message : [];
  const parts = [];
  for (const seg of segs) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': {
        const t = String(d.text ?? '').trim();
        if (t) parts.push(t);
        break;
      }
      case 'at':
        if (d.qq) parts.push(`@${d.qq}`);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'mface':
        parts.push('[表情包]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'face':
        parts.push('[QQ表情]');
        break;
      case 'reply':
      case 'json':
        break;
      case 'forward':
        parts.push('[合并转发]');
        break;
      default:
        if (seg?.type) parts.push(`[${seg.type}]`);
    }
  }
  return parts.join(' ').trim();
}

function pickExt(data) {
  const probe = `${data?.file ?? ''} ${data?.url ?? ''}`;
  const m = probe.match(IMG_EXT_RE);
  return m ? m[0].toLowerCase() : '.png';
}

// ---- 存图去重（2026-10-17 主人拍板"一样只留一份"）----
// 按内容 sha256 认图：同样的图只落一份，再来一张就复用先前那个路径。
// 索引在 media\content-index.json（hash → 绝对路径），没进索引的老文件靠"同尺寸再比内容"兜底。
const MEDIA_INDEX_PATH = path.join(MEDIA_DIR, 'content-index.json');
let mediaIndexCache = null;

function loadMediaIndex() {
  if (mediaIndexCache) return mediaIndexCache;
  try {
    const obj = JSON.parse(fs.readFileSync(MEDIA_INDEX_PATH, 'utf8'));
    mediaIndexCache = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    mediaIndexCache = {};
  }
  return mediaIndexCache;
}

function saveMediaIndex() {
  try {
    fs.writeFileSync(MEDIA_INDEX_PATH, JSON.stringify(loadMediaIndex()), 'utf8');
  } catch (e) {
    log('存图索引写失败:', e?.message ?? String(e));
  }
}

function fileSha256(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function findStoredByHash(hash, size) {
  const idx = loadMediaIndex();
  const hit = idx[hash];
  if (typeof hit === 'string' && hit && fs.existsSync(hit)) return hit;
  for (const dir of [MEDIA_DIR, path.join(CFG.home, 'memes')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!IMG_EXT_RE.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size !== size) continue;
        if (fileSha256(p) === hash) { idx[hash] = p; return p; }
      } catch { /* 单个文件读不了就跳过 */ }
    }
  }
  return null;
}

// 表情包常被 QQ 报成 .png、实际是 gif —— 按文件头认，别信名字
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return '.gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
  return '';
}

// 收到的图片/表情包：落到 media/，返回本机路径（鲸鱼可以直接用看图工具看）
async function saveIncomingImage(data) {
  try {
    const raw = typeof data?.file === 'string' ? data.file : '';
    const local = raw.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    let buf = null;
    if (local && path.isAbsolute(local) && fs.existsSync(local)) {
      buf = fs.readFileSync(local);
    } else {
      const url = data?.url ?? (/^https?:\/\//.test(raw) ? raw : '');
      if (!url) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    }
    if (!buf || !buf.length) return null;

    const hash = createHash('sha256').update(buf).digest('hex');
    const dup = findStoredByHash(hash, buf.length);
    if (dup) {
      saveMediaIndex();
      log('存图：内容重复，复用', path.basename(dup));
      return dup;
    }

    const ext = sniffImageExt(buf) || pickExt(data);
    const out = path.join(MEDIA_DIR, `in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
    fs.writeFileSync(out, buf);
    loadMediaIndex()[hash] = out;
    saveMediaIndex();
    return out;
  } catch (e) {
    log('存图失败:', e?.message ?? String(e));
    return null;
  }
}

// ---------- 收文件（2026-10-17 晚上加，主人说"收文件的代码你可以先做"）----------
// QQ 里发来的文件是 file 段：{ file: 文件名, file_id: 文件uuid, file_size, url? }。
// 原先 buildIncoming 只把 file 当未知类型落成 "[file]"，正文一个字都进不来——
// 10-17 主人发的那张 211 行角色卡就是这么白发的。
// 现在的路：能直链就先直链，不能就拿 file_id 找通道要（get_file / get_private_file_url /
// get_group_file_url 三条挨个试）；拿到就落 media\files\，文本类顺手把正文读出来塞进上下文。
// 注意：只落盘、只读文本，不解压、不执行任何东西。
const FILES_DIR = path.join(CFG.home, 'media', 'files');
const FILE_MAX_BYTES = 50 * 1024 * 1024; // 超过 50MB 不要了（QQ 文件本来也少见这么大）
const FILE_TEXT_MAX_BYTES = 400 * 1024; // 文本类超过 400KB 就不读正文，只给路径
const FILE_TEXT_MAX_CHARS = 20000; // 塞进上下文的正文上限，免得一条消息把预算吃光
const TEXT_EXT_RE = /\.(txt|md|markdown|json|jsonl|js|mjs|cjs|ts|py|ps1|bat|cmd|log|csv|tsv|ya?ml|toml|ini|cfg|conf|html?|xml|css|jsx|tsx|java|c|cc|cpp|h|hpp|go|rs|sql|lua|sh|env)$/i;

function safeBaseName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() || 'file';
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file';
}

async function fetchToBuffer(url, limitBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len && len > limitBytes) throw new Error(`文件太大（${(len / 1048576).toFixed(1)}MB）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limitBytes) throw new Error(`文件太大（${(buf.length / 1048576).toFixed(1)}MB）`);
  return buf;
}

// 无 BOM 的 UTF-8 优先；读着全是替换符就按 GBK 再试（Windows 上 txt 很常见，Node 自带 ICU 支持 gbk）
function decodeTextSafe(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch {
    /* 没编进 ICU 就算了 */
  }
  return utf8;
}

// 收一个文件：返回 { path, name, size, text, hint }，拿不到返回 null
async function saveIncomingFile(data, msg) {
  try {
    const name = safeBaseName(data?.file);
    let buf = null;
    let where = '';

    // 1) 消息段自带直链
    const inlineUrl = typeof data?.url === 'string' && /^https?:\/\//.test(data.url) ? data.url : '';
    if (inlineUrl) {
      try {
        buf = await fetchToBuffer(inlineUrl, FILE_MAX_BYTES);
        where = 'url';
      } catch (e) {
        log('收文件：直链下载失败', e?.message ?? String(e));
      }
    }

    // 2) file 本身就是本机路径（NapCat 没开本地文件转 URL 时可能是这种）
    if (!buf) {
      const raw = String(data?.file ?? '').replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
      if (raw && path.isAbsolute(raw)) {
        try {
          if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
            buf = fs.readFileSync(raw);
            where = 'local';
          }
        } catch (e) {
          log('收文件：本地读取失败', e?.message ?? String(e));
        }
      }
    }

    // 3) 找通道要：三条 API 挨个试，谁先给内容用谁
    if (!buf) {
      const fileId = typeof data?.file_id === 'string' ? data.file_id : '';
      const tries = [];
      if (fileId) tries.push(['get_file', { file: fileId }]);
      if (fileId && msg?.message_type === 'private') tries.push(['get_private_file_url', { user_id: msg.user_id, file_id: fileId }]);
      if (fileId && msg?.message_type === 'group') tries.push(['get_group_file_url', { group_id: msg.group_id, file_id: fileId, busid: 102 }]);
      for (const [action, params] of tries) {
        let info;
        try {
          info = await callAction(action, params, 90000);
        } catch (e) {
          log(`收文件：${action} 失败`, e?.message ?? String(e));
          continue;
        }
        try {
          if (typeof info?.base64 === 'string' && info.base64) {
            buf = Buffer.from(info.base64, 'base64');
            where = action;
            break;
          }
          const p = typeof info?.file === 'string' ? info.file.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '') : '';
          if (p && path.isAbsolute(p) && fs.existsSync(p)) {
            buf = fs.readFileSync(p);
            where = action;
            break;
          }
          const u = typeof info?.url === 'string' && /^https?:\/\//.test(info.url) ? info.url : '';
          if (u) {
            buf = await fetchToBuffer(u, FILE_MAX_BYTES);
            where = action;
            break;
          }
        } catch (e) {
          log(`收文件：${action} 拿到的东西用不了`, e?.message ?? String(e));
        }
      }
    }

    if (!buf || !buf.length) {
      log('收文件：所有路子都没拿到内容', JSON.stringify(data ?? {}).slice(0, 300));
      return null;
    }

    fs.mkdirSync(FILES_DIR, { recursive: true });
    const out = path.join(FILES_DIR, `in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${name}`);
    fs.writeFileSync(out, buf);
    log(`收文件：${name} ${buf.length} 字节（来源 ${where || '?'}）→ ${path.basename(out)}`);

    let text = '';
    let hint = '';
    const looksBinary = buf.subarray(0, 4096).includes(0);
    if (TEXT_EXT_RE.test(name) && !looksBinary) {
      if (buf.length > FILE_TEXT_MAX_BYTES) {
        hint = '（太大，没读正文；要看就自己打开读）';
      } else {
        text = decodeTextSafe(buf);
        if (text.length > FILE_TEXT_MAX_CHARS) {
          text = `${text.slice(0, FILE_TEXT_MAX_CHARS)}\n……（后面还有 ${text.length - FILE_TEXT_MAX_CHARS} 字没显示，要全文就读本机那个路径）`;
        }
      }
    } else {
      hint = looksBinary ? '（二进制文件，没读内容）' : '（不是文本，没读内容）';
    }

    return { path: out, name, size: buf.length, text, hint };
  } catch (e) {
    log('收文件失败:', e?.message ?? String(e));
    return null;
  }
}

// 把一条消息整理成给鲸鱼看的文字：文字照旧，图/表情落盘并把路径带上
// 收到主人发来的语音：把音频取回本地，再用本地 whisper 转成文字（不联网、不花钱）
// 2026-10-19 修：实测 NapCat 推过来的 record 段里没有 url/path（拿不到地址时对端只给 file 这个加密 ID，
// 有时还带 path 但是空的），所以原来那条「等它自带地址」的路永远走不到。改成：有地址用地址，
// 没地址就拿 file 这个 ID 调 get_record（OneBot 标准动作，NapCat 走 downloadMedia 下载到本地），
// 要 mp3 让人家顺手转好——我们这边 ffmpeg 不认 silk。再不行，只要响应里带 base64 也能落盘。
async function saveIncomingRecord(d, msg) {
  const dir = path.join(CFG.home, 'media', 'voice', 'in');
  fs.mkdirSync(dir, { recursive: true });
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const url = str(d.url);
  const p = str(d.path);
  const file = str(d.file);
  log('收语音：段的字段', JSON.stringify({ url: url.slice(0, 60), path: p, file: file.slice(0, 40), file_size: d.file_size }));
  const baseName = (() => {
    const cand = [p, file, url].join(' ');
    const m = /([0-9a-fA-F]{16,})\.([A-Za-z0-9]{2,5})/.exec(cand);
    if (m) return `${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
    return `in-${Date.now()}.mp3`;
  })();
  const dest = path.join(dir, baseName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;

  // 1) 段里自带下载地址
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      if (fs.statSync(dest).size > 0) return dest;
    } catch (e) {
      log('收语音：下载失败', e?.message ?? String(e));
    }
  }

  // 2) 段里自带本地路径（也可能是个不存在的旧路径，先看存在不存在）
  if (p && fs.existsSync(p)) {
    try {
      fs.copyFileSync(p, dest);
      if (fs.statSync(dest).size > 0) return dest;
    } catch (e) {
      log('收语音：复制失败', e?.message ?? String(e));
    }
  }

  // 3) 拿 file 这个 ID 叫 NapCat 下载（它认这个加密串；要 mp3，别让我们去解 silk）
  if (file) {
    try {
      const r = await callAction('get_record', { file, out_format: 'mp3' }, 60000);
      const rf = str(r?.file) || str(r?.url);
      if (rf && fs.existsSync(rf)) {
        // 对端转成的是不是 mp3 不确定，按它给的扩展名存，别硬改名让 ffmpeg 猜错容器
        const ext = (path.extname(rf) || '.mp3').toLowerCase();
        const dst = fs.existsSync(dest) && ext === '.mp3' ? dest : path.join(dir, `rec-${Date.now()}${ext}`);
        fs.copyFileSync(rf, dst);
        if (fs.statSync(dst).size > 0) return dst;
      }
      const b64 = str(r?.base64);
      if (b64) {
        fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
        if (fs.statSync(dest).size > 0) return dest;
      }
      log('收语音：get_record 没给出可用的文件', JSON.stringify({ file: str(r?.file).slice(0, 60), url: str(r?.url).slice(0, 60), size: r?.file_size }));
    } catch (e) {
      log('收语音：get_record 失败', e?.message ?? String(e));
    }
  }
  return null;
}

// 本地 whisper 转写。用 16k 单声道 wav 喂它；temp 指到已验过的 _e2e\tmp（spawn 会继承我们的环境）
async function transcribeAudio(src) {
  if (!CFG.ffmpeg || !CFG.voiceWhisper) return null; // 没配 ffmpeg/whisper 就别折腾，收语音只留占位
  const work = path.join(CFG.home, 'tools', '_e2e');
  fs.mkdirSync(work, { recursive: true });
  const stem = path.basename(src).replace(/\.[^.]+$/, '');
  const wav = path.join(work, `rec-${stem}.wav`);
  const outBase = path.join(work, `rec-${stem}`);
  const env = { ...process.env, TEMP: path.join(work, 'tmp'), TMP: path.join(work, 'tmp') };
  fs.mkdirSync(env.TEMP, { recursive: true });
  const conv = await runProc(CFG.ffmpeg, [
    '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
  ], { timeoutMs: 120000, env });
  if (!conv.ok || !fs.existsSync(wav)) {
    log('收语音：转 wav 失败', (conv.err || '').slice(0, 160));
    return null;
  }
  const tr = await runProc(CFG.voiceWhisper, [
    '-m', CFG.voiceWhisperModel, '-f', wav, '-l', 'zh', '-otxt', '-of', outBase, '-t', '6',
  ], { timeoutMs: 300000, env });
  const txtPath = `${outBase}.txt`;
  if (!fs.existsSync(txtPath)) {
    log('收语音：转写没出结果', (tr.err || tr.out || '').slice(0, 160));
    return null;
  }
  let text = fs.readFileSync(txtPath, 'utf8').replace(/\s+/g, '').trim();
  // whisper 吐的是繁体：用装修队那份 zh-simp.mjs（同一张 OpenCC 映射表，别另造轮子）转简体
  try {
    const simpScript = path.join(CFG.home, 'tools', 'zh-simp.mjs');
    if (text && fs.existsSync(simpScript)) {
      const simpOut = `${outBase}.zh.txt`;
      const sr = await runProc(process.execPath, [simpScript, txtPath, simpOut], { timeoutMs: 60000, env });
      if (sr.ok && fs.existsSync(simpOut)) {
        text = fs.readFileSync(simpOut, 'utf8').replace(/\s+/g, '').trim();
        fs.unlinkSync(simpOut);
      } else {
        log('收语音：转简体失败，先用繁体', (sr.err || '').slice(0, 120));
      }
    }
  } catch (e) {
    log('收语音：转简体异常', e?.message ?? String(e));
  }
  for (const junk of [wav, txtPath, `${outBase}.srt`, `${outBase}.vtt`]) {
    try {
      if (fs.existsSync(junk)) fs.unlinkSync(junk);
    } catch {
      /* ignore */
    }
  }
  return text || null;
}

// 转写结果按音频文件名缓存（同一句语音推两次不重复跑模型）
async function recordToText(rec) {
  if (!rec) return null;
  const cache = path.join(CFG.home, 'media', 'voice', 'in', `${path.basename(rec).replace(/\.[^.]+$/, '')}.zh.txt`);
  try {
    if (fs.existsSync(cache)) {
      const t = fs.readFileSync(cache, 'utf8').trim();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  const text = await transcribeAudio(rec);
  if (text) {
    try {
      fs.writeFileSync(cache, text, 'utf8');
    } catch {
      /* ignore */
    }
  }
  return text;
}

// ---- 合并转发（2026-10-18 主人点头「你去改吧」）----
// 转发段推过来常常只有个 id（NapCat 的 parseMultMsg 是 false），里面一个字都看不到。
// 所以这里拿 id 调 get_forward_msg 把每条拉出来；段里要是本来就带了 content，就直接用，省一次动作。
// 只读文字：里面的图/语音/文件一律只留占位，不下载、不转写——转发里塞几十张图会把预算吃光。
const FORWARD_MAX_ITEMS = 20; // 一次最多读几条
const FORWARD_MAX_CHARS = 3000; // 整段最多塞多少字
const FORWARD_ITEM_CHARS = 300; // 单条最多留多少字

function forwardSegText(segs) {
  const out = [];
  for (const seg of Array.isArray(segs) ? segs : []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': {
        const t = String(d.text ?? '');
        if (t.trim()) out.push(t);
        break;
      }
      case 'image':
      case 'mface':
        out.push(seg.type === 'mface' ? '[表情包]' : '[图片]');
        break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ? `：${d.name}` : ''}]`); break;
      case 'face': out.push('[QQ表情]'); break;
      case 'json':
      case 'xml': out.push('[卡片]'); break;
      case 'at': out.push(`@${d.qq ?? ''}`); break;
      case 'forward': out.push('[里面还套着一条转发，没展开]'); break;
      case 'reply': break;
      default:
        if (seg?.type) out.push(`[${seg.type}]`);
    }
  }
  return out.join(' ').replace(/[ \t]+/g, ' ').trim();
}

function renderForwardList(messages) {
  const list = Array.isArray(messages) ? messages : (messages?.messages ?? []);
  if (!Array.isArray(list) || !list.length) return '';
  const lines = [];
  let total = 0;
  for (const m of list) {
    if (lines.length >= FORWARD_MAX_ITEMS) {
      lines.push(`（后面还有，先看这 ${FORWARD_MAX_ITEMS} 条）`);
      break;
    }
    const nick = m?.sender?.card || m?.sender?.nickname || m?.nickname
      || (m?.user_id ? `QQ${m.user_id}` : '某人');
    let body = forwardSegText(m?.message ?? m?.content ?? []);
    if (!body) body = '[不是文字，读不着]';
    if (body.length > FORWARD_ITEM_CHARS) body = `${body.slice(0, FORWARD_ITEM_CHARS)}…`;
    const line = `${lines.length + 1}. ${nick}：${body}`;
    if (total + line.length > FORWARD_MAX_CHARS) {
      lines.push('（太长了，后面的先不读）');
      break;
    }
    total += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

async function fetchForwardMessages(d) {
  const inline = d?.content ?? d?.messages;
  if (Array.isArray(inline) && inline.length) return inline;
  const id = d?.id ?? d?.res_id ?? d?.resId ?? d?.message_id;
  if (!id) return null;
  try {
    const r = await callAction('get_forward_msg', { message_id: String(id) }, 25000);
    const list = Array.isArray(r) ? r : r?.messages;
    if (Array.isArray(list) && list.length) return list;
    log('拉转发内容：拿到了但里面是空的', String(id));
    return null;
  } catch (e) {
    log('拉转发内容失败:', String(id), e?.message ?? String(e));
    return null;
  }
}

async function buildIncoming(msg, opts = {}) {
  const allowMedia = opts.allowMedia !== false; // false = 临时放开进来的陌生人：只收文字，不碰文件
  const segs = Array.isArray(msg.message) ? msg.message : [];
  const parts = [];
  let images = 0;
  for (const seg of segs) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': {
        const t = String(d.text ?? '').trim();
        if (t) parts.push(t);
        break;
      }
      case 'image':
      case 'mface': {
        const label = seg.type === 'mface' ? '表情包' : '图片';
        if (!allowMedia) {
          parts.push(`[${label}：没取，只看字]`);
          break;
        }
        const p = await saveIncomingImage(d);
        if (p) {
          images++;
          parts.push(`[${label}已存到本机：${p}]`);
        } else {
          parts.push(`[${label}：没取到，看不了]`);
        }
        break;
      }
      case 'face':
        parts.push(`[QQ自带表情 id=${d.id ?? '?'}]`);
        break;
      case 'record': {
        // 主人发来的语音：取回音频 + 本地 whisper 转文字，再当普通消息接着聊
        if (!allowMedia) {
          parts.push('[一条语音：没取，听不了]');
          break;
        }
        const rec = await saveIncomingRecord(d, msg);
        if (!rec) {
          parts.push('[主人发来一条语音：没取到音频，听不了]');
          break;
        }
        const heard = await recordToText(rec);
        parts.push(heard
          ? `[主人发来一条语音，我听到的是：${heard}]`
          : '[主人发来一条语音：没听清（转写失败）]');
        break;
      }
      case 'at':
        parts.push(`@${d.qq ?? ''}`);
        break;
      case 'file': {
        // 主人发文件（10-17 补的路）：落盘，文本类直接把正文读进来
        if (!allowMedia) {
          parts.push('[一个文件：没取，下不下来]');
          break;
        }
        const got = await saveIncomingFile(d, msg);
        if (!got) {
          parts.push('[文件：没取到内容，下不下来]');
          break;
        }
        if (got.text) {
          parts.push(`[主人发来一个文件：${got.name}（${got.size} 字节），已存本机 ${got.path}；正文如下：\n${got.text}\n（正文到此为止）]`);
        } else {
          parts.push(`[主人发来一个文件：${got.name}（${got.size} 字节），已存本机 ${got.path}${got.hint}]`);
        }
        break;
      }
      case 'reply':
      case 'json':
        break;
      case 'forward': {
        // 合并转发：按 id 把里面每条拉出来读文字（见上面 fetchForwardMessages）
        if (!allowMedia) {
          parts.push('[一条合并转发：没取，看不了]');
          break;
        }
        const list = await fetchForwardMessages(d);
        const body = list ? renderForwardList(list) : '';
        if (!body) {
          parts.push('[一条合并转发，但里面的内容没拉下来]');
          break;
        }
        const count = Array.isArray(list) ? list.length : (list?.messages?.length ?? 0);
        parts.push(`[发来一条合并转发，里面 ${count} 条，我读到的是：\n${body}\n（转发正文到此为止）]`);
        break;
      }
      default:
        if (seg?.type) parts.push(`[${seg.type}]`);
    }
  }
  return { text: parts.join(' ').trim(), images };
}

// 回话里写 [CQ:image,file=本机路径] 时，把本机文件转成 base64 再发（NapCat 没开"本地文件转 URL"）
function cqImageToBase64(text) {
  return String(text ?? '').replace(/\[CQ:image,([^\]]*)\]/g, (whole, attrs) => {
    const kv = {};
    for (const piece of String(attrs).split(',')) {
      const i = piece.indexOf('=');
      if (i > 0) kv[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
    }
    let file = kv.file ?? '';
    if (!file || /^https?:\/\//.test(file) || file.startsWith('base64://')) return whole;
    file = file.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    try {
      if (!fs.existsSync(file)) return `[图片没找到：${file}]`;
      return `[CQ:image,file=base64://${fs.readFileSync(file).toString('base64')}]`;
    } catch (e) {
      return `[图片发不出去：${e?.message ?? e}]`;
    }
  });
}

function allowed(msg) {
  const uid = Number(msg.user_id);
  if (msg.message_type === 'private') return CFG.allowlist.includes(uid);
  if (msg.message_type === 'group') {
    // 群号白名单（10-17 加）：主人说只在他那个群里说话，别处一概不理。
    if (CFG.groupAllow?.length && !CFG.groupAllow.includes(Number(msg.group_id))) return false;
    // 群里认两种人：主人，和主人点名放进来的人（10-17 19:30 加了猫娘）；别的人话都不进来。
    if (CFG.allowlist.includes(uid)) return true;
    if ((CFG.groupTalkAllow ?? []).includes(uid)) return true;
    // 临时放开整群（10-18 19:20 主人点头）：到点自动收回，谁的叫我都能接；私聊不放。
    return groupOpenUntil(msg.group_id) > 0;
  }
  return false;
}

// 这一条是不是在叫我：@ 我、带我的号、或者提到小鲸／鲸鱼／回声。
// 没叫我的群消息不丢，走下面的 ambient 路收进上下文；叫了才真的开口（10-17 主人改的口径）。
function isAddressed(msg) {
  if (msg.message_type !== 'group') return true;
  const text = extractText(msg);
  const atMe = Array.isArray(msg.message)
    && msg.message.some((s) => s?.type === 'at' && String(s?.data?.qq) === String(CFG.adminQq));
  return atMe || text.includes(String(CFG.adminQq)) || KIT_NAMES.some((n) => n.trim() && text.includes(n.trim()));
}

function rateLimited() {
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0] > 60000) rateWindow.shift();
  if (rateWindow.length >= CFG.maxPerMinute) return true;
  rateWindow.push(now);
  return false;
}

async function handleIncoming(msg) {
  if (Number(msg.user_id) === Number(CFG.adminQq)) return; // 机器人自己发的不理
  // 群聊总开关（10-17 17:23 主人说"你打开"）：关了就连群消息都不看。
  if (msg.message_type === 'group' && !CFG.groupEnabled) {
    log('群聊功能已关，忽略群消息:', msg.group_id, msg.user_id, extractText(msg).slice(0, 40));
    return;
  }
  // 群里的耳朵（2026-10-18 20:0x 主人点头）：先听一耳朵，只进内存、不进档案、不下载图，
  // 像在说我的才叫一次模型判断要不要回；主人和白名单的照旧走下面正常路。
  if (msg.message_type === 'group' && earGroup(msg.group_id)) {
    const spoken = ambientText(msg);
    rememberEarLine(msg, spoken);
    if (spoken) {
      maybeJudgeEars(msg, spoken).catch((e) => log('耳朵出岔子:', e?.message ?? String(e)));
    }
  }
  // 白名单闸（2026-10-16 21:45 主人点头后从下面挪上来的）：原来先 buildIncoming 再判白名单，
  // 陌生人和群里的图会先落进 media/、陌生人的语音会先跑一遍 whisper 转写，之后才被丢掉——
  // 就是 10-16 那批群图（36 张）混进收件夹的原因。现在先判再动，非白名单一律不下载、不转写、不落盘。
  if (!allowed(msg)) {
    log('不在白名单，忽略:', msg.message_type, msg.user_id, describeSegments(msg));
    return;
  }
  // 暂停开关放到下载之前：暂停期间不下载图、不转写语音，也不收上下文。
  const mode = pauseMode();
  if (mode === 'all' || (mode === 'group-mute' && msg.message_type === 'group')) {
    log('暂停中，这条不理:', msg.message_type, msg.user_id);
    return;
  }
  // 群里的主人没叫我：话照收进上下文，但不回、不叫模型（2026-10-17 18:14 主人拍板）。
  // 只收文字和占位，图/语音不下载不转写；别人说的话仍然不接。
  if (msg.message_type === 'group' && !isAddressed(msg)) {
    const spoken = ambientText(msg);
    if (!spoken) {
      log('空消息，忽略:', msg.message_type, msg.user_id);
      return;
    }
    const nick = msg.sender?.card || msg.sender?.nickname || '';
    enqueue(conversationKey(msg), {
      mode: 'ambient',
      kind: 'group',
      target: msg.group_id,
      sender: msg.user_id,
      text: `[群里 ${nick}(${msg.user_id}) 说·没叫我] ${spoken}`,
    });
    log('群里没叫我，收进上下文:', msg.group_id, msg.user_id, spoken.slice(0, 60));
    return;
  }
  const { text, images } = await buildIncoming(msg, { allowMedia: mediaTrusted(msg) });
  if (!text && !images) {
    log('空消息，忽略:', msg.message_type, msg.user_id);
    return;
  }
  // （白名单和暂停开关已在上面判过，这里不再判）
  // 口令重启（2026-10-16 加的）：鲸鱼自己在沙箱里碰不到本体进程，所以不给它命令，
  // 改由本体自己退出——外面 bot-runner.bat 的 :loop 会在 5 秒后把它重新拉起来。
  // 只认主人私聊、且整条消息就等于这几个字（同一句里夹带别的话不算），免得误触。
  const restartCmd = text.trim();
  if (msg.message_type === 'private'
      && (restartCmd === '重启你自己' || restartCmd === '重启一下你自己' || restartCmd === '回炉重造')) {
    log('收到重启口令，回执后退出，等守护重拉');
    // 队列里还有活时别把自己掐了：echo 正说到一半时收到口令，先回一句、等这条处理完再重启。
    const q = queues.get(`private:${msg.user_id}`);
    if (q && q.running) {
      await reply('private', msg.user_id, '手头这条还没说完，等它落地我就去换气——你过十秒再说一次 🐳');
      return;
    }
    await reply('private', msg.user_id, '收到，我去换口气——五秒后回来 🐳');
    await sleep(600);
    process.exit(0);
  }
  if (rateLimited()) {
    const kind = msg.message_type === 'group' ? 'group' : 'private';
    await reply(kind, kind === 'group' ? msg.group_id : msg.user_id, '慢点慢点，我有点忙不过来 🐳');
    return;
  }
  const kind = msg.message_type === 'group' ? 'group' : 'private';
  // 群聊里把说话的人带上，记忆账本要靠它分人
  const nick = msg.sender?.card || msg.sender?.nickname || '';
  const fromOwner = CFG.allowlist.includes(Number(msg.user_id));
  const withWho = kind !== 'group'
    ? text
    : (fromOwner
      ? `[群里 ${nick}(${msg.user_id}) 说] ${text}`
      : `[群里 ${nick}(${msg.user_id}) 跟你说·不是你主人，主人是 ${CFG.allowlist[0]}] ${text}`);
  enqueue(conversationKey(msg), {
    kind,
    target: kind === 'group' ? msg.group_id : msg.user_id,
    sender: msg.user_id,
    text: withWho,
  });
}

// ---------- 自测模式（不经过 QQ，直接跑一轮鲸鱼，验证管线） ----------
if (process.argv.includes('--selftest')) {
  const text = process.argv[process.argv.indexOf('--selftest') + 1] ?? '你好，用一句话自我介绍';
  const key = `private:${CFG.allowlist[0]}`;
  const prompt = `${styleHeader()}\n${text}`;
  log('自测：直接把一轮请求送给鲸鱼（不连 QQ）');
  const res = await runWhale(prompt, state.sessions[key] ?? null);
  if (res.sid) {
    state.sessions[key] = res.sid;
    saveState();
  }
  log(`自测结果 ok=${res.ok} ms=${res.ms} sid=${res.sid ?? '-'}`);
  console.log('--- 鲸鱼回复 ---');
  console.log(res.ok ? res.text : `[失败] ${res.error}`);
  process.exit(res.ok ? 0 : 1);
}

// ---------- 记性自检（不连 QQ、不花模型钱）：看一眼下一轮开口会带哪些东西 ----------
if (process.argv.includes('--memory-dump')) {
  ensureBase(PRIMARY_KEY);
  console.log(memoryBlock(PRIMARY_KEY));
  console.log(`--- meta ---`);
  console.log(JSON.stringify(readMeta(PRIMARY_KEY), null, 2));
  process.exit(0);
}

// ---------- 提示预览（只拼、不发、不花模型钱）：看下一轮开口的完整顺序 ----------
if (process.argv.includes('--prompt-preview')) {
  const i = process.argv.indexOf('--prompt-preview');
  const t = process.argv[i + 1] || '(预览：这句话不会发出去)';
  console.log(buildTurnPrompt(PRIMARY_KEY, t, { withHeader: true, dry: true }));
  process.exit(0);
}

// ---------- 每周自检预演（只看拼出来的句子，不发、不花模型钱） ----------
if (process.argv.includes('--weekly-check-dry')) {
  console.log(weeklyCheckText() || '(档案目录里没有页可查)');
  process.exit(0);
}

// ---------- 事件卡预演：给一句话，看会落成什么卡；不写盘 ----------
if (process.argv.includes('--card-dry')) {
  const t = process.argv[process.argv.indexOf('--card-dry') + 1] ?? '';
  const day = logicalDay();
  console.log(`会写吗：${shouldCard(t) ? '写' : '不写（太短或纯应答）'}`);
  console.log(`目录：${cardDayDir(PRIMARY_KEY, day)}`);
  console.log(`标题：${cardTitle(t)}`);
  console.log(`原话：${cardQuote(t)}`);
  process.exit(0);
}

// ---------- 事件卡落盘自测：写进 days\_selftest，不碰真会话的卡 ----------
if (process.argv.includes('--card-test')) {
  const t = process.argv[process.argv.indexOf('--card-test') + 1] || '这是一张测试卡：验证事件卡会落在哪、长什么样';
  const p = writeEventCard('selftest:card', t, { force: true });
  console.log(p ? `写好了：${p}` : '没写成，看日志');
  process.exit(p ? 0 : 1);
}

// ---------- 结账预演：看这天的卡会被怎么喂给四点结账 ----------
if (process.argv.includes('--close-dry')) {
  const day = process.argv[process.argv.indexOf('--close-dry') + 1] || logicalDay();
  console.log(readDayCards(PRIMARY_KEY, day) || `(${day} 这天没有事件卡)`);
  process.exit(0);
}

// ---------- 收文件自检（不连 QQ，直接走"本机路径"那条分支，验证落盘+解码+截断） ----------
if (process.argv.includes('--file-selftest')) {
  const p = process.argv[process.argv.indexOf('--file-selftest') + 1];
  const got = await saveIncomingFile({ file: p, file_id: '' }, { message_type: 'private', user_id: CFG.allowlist[0] });
  if (!got) {
    console.log('FAILED: 没拿到');
    process.exit(1);
  }
  console.log(JSON.stringify({
    name: got.name,
    size: got.size,
    path: got.path,
    textLen: got.text.length,
    head: got.text.slice(0, 60),
    tail: got.text.slice(-60),
    hint: got.hint,
  }, null, 2));
  process.exit(0);
}

// ---------- 启动 ----------
log('===== 小鲸鱼机器人启动 =====');
log(`版本：${BOT_BUILD}`);
log(`配置：profile=${CFG.profile} home=${CFG.home} 白名单=${CFG.allowlist.join(',')}`);
log(`群聊：${CFG.groupEnabled ? '开' : '关'}${CFG.groupAllow?.length ? `（只听群 ${CFG.groupAllow.join(',')}）` : ''}${CFG.groupTalkAllow?.length ? `；接话白名单 ${CFG.groupTalkAllow.join(',')}` : ''}；没叫我时只收上下文`);
for (const g of (CFG.groupAllow?.length ? CFG.groupAllow : [0])) {
  const until = groupOpenUntil(g);
  if (until) log(`临时群白名单：群 ${g} 开着，到 ${new Date(until).toLocaleString('zh-CN', { hour12: false })} 自动收回`);
}
log(`权限档：${readPermissionMode()}（开关文件 ${PERM_FILE}）`);
pruneMedia();
outbox.start(); // 发件箱：先把上次没发完的接着发（连接起来之前泵会等着）
connect();
scheduleReminders();
setInterval(scheduleReminders, CFG.reminderTickMs);

// 主动搭话与日记：低频巡检（每分钟看一眼，各自内部有节流与时间窗判断）
setInterval(() => {
  maybeProactivePing().catch((e) => log('主动搭话巡检异常:', e?.message ?? String(e)));
}, CFG.housekeepingTickMs);
setInterval(() => {
  maybeWriteDiary().catch((e) => log('日记巡检异常:', e?.message ?? String(e)));
}, CFG.housekeepingTickMs);

// 换日结账：启动后先补一次（电脑关着的那几天开机补），以后每 10 分钟看一眼
setTimeout(() => {
  rollAllDays().catch((e) => log('换日巡检异常:', e?.message ?? String(e)));
}, 15 * 1000);
setInterval(() => {
  rollAllDays().catch((e) => log('换日巡检异常:', e?.message ?? String(e)));
}, 10 * 60 * 1000);

// [谷时压缩]：每 10 分钟看一眼，到谷时且有会话积压就压一次
setInterval(() => {
  batchCompress().catch((e) => log('[谷时压缩] 巡检异常:', e?.message ?? String(e)));
}, 10 * 60 * 1000);

// 每周自检：每 10 分钟看一眼，周日晚上八点后发一次（本地拼句子，不花模型钱）
setTimeout(() => {
  maybeWeeklyCheck().catch((e) => log('每周自检异常:', e?.message ?? String(e)));
}, 90 * 1000);
setInterval(() => {
  maybeWeeklyCheck().catch((e) => log('每周自检异常:', e?.message ?? String(e)));
}, 10 * 60 * 1000);

// 把 DSH 主会话里的对话同步给鲸鱼（纯本地抽取主人原话，不花模型钱）：
// 只在主会话日志有新内容时跑一次，免得白转。
let lastSyncRef = 0;
setInterval(() => {
  try {
    if (!CFG.syncScript || !fs.existsSync(CFG.syncScript)) return;
    const cur = newestSessionFile();
    if (!cur) return;
    const mtime = fs.statSync(cur.file).mtimeMs;
    if (mtime <= lastSyncRef) return;
    lastSyncRef = mtime;
    const r = spawnSync(process.execPath, [CFG.syncScript, cur.file, CFG.syncOut], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    if (r.status === 0) log('DSH 对话已同步给鲸鱼:', (r.stdout ?? '').split('\n')[0]);
    else log('同步失败:', (r.stderr ?? r.stdout ?? '').slice(0, 200));
  } catch (e) {
    log('同步异常:', e?.message ?? String(e));
  }
}, 10 * 60 * 1000);

// 找主工作区里最近改动的会话日志（本窗口的那份）
function newestSessionFile() {
  const root = CFG.syncSessionRoot;
  if (!root || !fs.existsSync(root)) return null;
  let best = null;
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith('.jsonl.zstd')) continue;
      const full = path.join(p, f);
      const s = fs.statSync(full);
      if (!best || s.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: s.mtimeMs, sessionId: dir };
    }
  }
  return best;
}

process.on('uncaughtException', (e) => log('未捕获异常:', e?.stack ?? String(e)));
process.on('unhandledRejection', (e) => log('未处理的 rejection:', e?.stack ?? String(e)));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，关闭中');
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
