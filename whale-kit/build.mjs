// 一键包组装脚本（只在本机跑，产物在 dist\）
// 干四件事：拷白板 home、改一份 whale-bot（去掉所有私人常量）、写配置模板、脱敏校验。
// 任何一步对不上就直接报错退出，绝不悄悄产出一个带隐私的包。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(KIT, 'src');
const DIST = path.join(KIT, 'dist');
const LIVE_BOT = 'D:\\QQWhale\\bot\\whale-bot.mjs';
const LIVE_OUTBOX = 'D:\\QQWhale\\bot\\outbox.mjs';
const LIVE_MEMO = 'D:\\QQWhale\\home\\tools\\memo-search.mjs';
const LIVE_PAGES = 'D:\\QQWhale\\home\\tools\\pages.mjs';

const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exit(1);
};
const ok = (msg) => console.log('· ' + msg);
const must = (cond, msg) => { if (!cond) fail(msg); };

function replaceOnce(text, from, to, label) {
  const n = text.split(from).length - 1;
  must(n === 1, `替换「${label}」命中 ${n} 次（应为 1 次），源码变过了，先改 build.mjs`);
  return text.replace(from, () => to);
}

// ---------- 1. 清空 dist ----------
if (path.dirname(DIST) !== KIT) fail('dist 路径不对：' + DIST);
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'bot'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'home'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'logs'), { recursive: true });

// ---------- 2. 白板 home ----------
fs.cpSync(path.join(SRC, 'home'), path.join(DIST, 'home'), { recursive: true });
for (const [name, body] of Object.entries({
  'notes.json': '[]\n',
  'reminders.json': '[]\n',
  'state.json': '{}\n',
  'archive/keep.jsonl': '',
  '要事.md': '# 要事\n\n<!-- 每天深夜机器人会往这里追加一段「## 日期 + 3-6 条要点」。 -->\n',
  'diary.jsonl': '',
  'media/.keep': '',
  'screens/.keep': '',
})) {
  const p = path.join(DIST, 'home', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, body, 'utf8');
}
ok('白板 home 就位');

// ---------- 3. 工具脚本 ----------
fs.mkdirSync(path.join(DIST, 'home', 'tools'), { recursive: true });
fs.copyFileSync(LIVE_MEMO, path.join(DIST, 'home', 'tools', 'memo-search.mjs'));
let pages = fs.readFileSync(LIVE_PAGES, 'utf8');
pages = replaceOnce(
  pages,
  "const HOME = 'D:/QQWhale/home';",
  "const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1')), '..');",
  'pages.mjs 的 HOME',
);
const oldPrefix = '//   D:\\QQWhale\\napcat\\node.exe tools\\pages.mjs ';
must(pages.split(oldPrefix).length - 1 === 2, 'pages.mjs 的用法注释变了');
pages = pages.split(oldPrefix).join('//   node tools\\pages.mjs ');
fs.writeFileSync(path.join(DIST, 'home', 'tools', 'pages.mjs'), pages, 'utf8');
ok('工具脚本已改为相对路径');

// ---------- 4. 改 whale-bot ----------
let bot = fs.readFileSync(LIVE_BOT, 'utf8');
const before = bot.length;

const cfgStart = bot.indexOf('const CFG = {');
const cfgEnd = bot.indexOf('\n};\n\nconst STATE_PATH', cfgStart);
must(cfgStart > 0 && cfgEnd > cfgStart, '没找到 CFG 配置块');

const PRELUDE = `// ---------- 配置：全部来自包目录下的 config.json，代码里不写死任何人的 QQ 号和机器路径 ----------
const KIT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1')), '..');
const KIT_CFG_PATH = path.join(KIT_ROOT, 'config.json');
if (!fs.existsSync(KIT_CFG_PATH)) {
  console.error('找不到 config.json：' + KIT_CFG_PATH);
  console.error('先双击「设置.bat」走一遍向导，再启动。');
  process.exit(1);
}
let KIT;
try {
  KIT = JSON.parse(fs.readFileSync(KIT_CFG_PATH, 'utf8').replace(/^\\uFEFF/, ''));
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
}`;

bot = bot.slice(0, cfgStart) + PRELUDE + bot.slice(cfgEnd + 3);

// 名字彩蛋要在聊天里落盘（config.json + home\AGENTS.md + DSH profile），跟设置向导共用一份实现
bot = replaceOnce(
  bot,
  "import { createOutbox } from './outbox.mjs';",
  "import { createOutbox } from './outbox.mjs';\nimport { applyName, takeNameMarkers } from '../bin/profile.mjs';",
  '名字彩蛋的 import',
);

bot = replaceOnce(
  bot,
  "const EAR_MENTION_RE = /小鲸|鲸鱼|回声|3118384201/;",
  "// 用一个带 test() 的小对象代替死正则：取名以后 KIT_NAMES 就地改，这里自动跟着变\nconst EAR_MENTION_RE = { test: (t) => KIT_NAMES.some((n) => String(t).includes(n.trim())) || (CFG.adminQq ? String(t).includes(String(CFG.adminQq)) : false) };",
  '耳朵叫名字',
);

// 改名字以后，群里不 @ 只叫新名字也得听得见；原来这里写死了三个默认名。
bot = replaceOnce(
  bot,
  'return atMe || text.includes(String(CFG.adminQq)) || /小鲸|鲸鱼|回声/.test(text);',
  'return atMe || text.includes(String(CFG.adminQq)) || KIT_NAMES.some((n) => n.trim() && text.includes(n.trim()));',
  '群里叫名字',
);

bot = replaceOnce(bot, "const gen = 'D:\\\\DSHWORK_ONE\\\\voice\\\\zv\\\\say-rvc-voice2.py';", "const gen = path.join(CFG.voiceDir, 'say-voice.py');", '语音脚本路径');

bot = replaceOnce(bot, 'if (says.length) bubbles.push(...says);', 'if (says.length) bubbles.push(...says); // 语音关着时这些句子按普通文字发', '语音改文字');
bot = replaceOnce(bot, 'if (says.includes(bubble)) {', 'if (CFG.voiceEnabled && says.includes(bubble)) {', '语音气泡判断');
bot = replaceOnce(bot, 'async function synthVoice(text) {\n  const clean', 'async function synthVoice(text) {\n  if (!CFG.voiceEnabled) return null;\n  const clean', '合成总开关');

bot = replaceOnce(
  bot,
  `  volatile.push('[语音：这一条如果该用声音说，就把要说的话单独写成 [语音]…[/语音]（最多两段、每段一两句）；主人没要求就用文字，别自己加。]');`,
  `  if (CFG.voiceEnabled) {
    volatile.push('[语音：这一条如果该用声音说，就把要说的话单独写成 [语音]…[/语音]（最多两段、每段一两句）；主人没要求就用文字，别自己加。]');
  }`,
  '语音提示行',
);

// 名字彩蛋：只在他本人私聊、且还没取名的时候，往每轮提示里贴一小段（问过一遍就换成"别再提"的说法）。
// styleParts 原来拿不到会话键，这里把 key 递进去；别的调用点照样能不带 key。
bot = replaceOnce(bot, 'function styleParts(dry = false) {', "function styleParts(dry = false, key = '') {", 'styleParts 带 key');
bot = replaceOnce(
  bot,
  'const { fixed, volatile } = styleParts(Boolean(opts.dry));',
  'const { fixed, volatile } = styleParts(Boolean(opts.dry), key);',
  'buildTurnPrompt 传 key',
);
bot = replaceOnce(
  bot,
  `  volatile.push(\`[当前时间：\${nowInBeijing()}（北京时间）]\`);`,
  `  if (key === PRIMARY_KEY && kitNamePending()) volatile.push(kitNameLine());
  volatile.push(\`[当前时间：\${nowInBeijing()}（北京时间）]\`);`,
  '名字彩蛋提示行',
);

// 所有往外发的字都过 kitNameHook：摘掉 [取名:名字] 记号（落盘走 bin\profile.mjs）、记下"问过了"。
bot = replaceOnce(
  bot,
  'async function reply(kind, id, text) {\n  // 先把 [语音]...[/语音] 摘出来',
  'async function reply(kind, id, text) {\n  text = kitNameHook(text, kind, id); // 名字彩蛋的隐藏记号先摘掉，绝不发到 QQ 上\n  // 先把 [语音]...[/语音] 摘出来',
  '发消息前摘名字记号',
);

bot = replaceOnce(
  bot,
  `const STYLE_FIXED_LINES = [
  '[QQ 会话 · 开口前先读 D:\\\\QQWhale\\\\home\\\\_回复风格.md；要记备忘或定提醒时读 D:\\\\QQWhale\\\\home\\\\_备忘与提醒.md]',
  '[主人也常在 DSH 桌面端跟我说话，那边的近况被同步在 D:\\\\QQWhale\\\\home\\\\sync-from-dsh.md；]',
  '[想了解"我们最近在忙什么"就读它，但别在回复里引用这个文件本身。]',
];`,
  `const STYLE_FIXED_LINES = [
  \`[QQ 会话 · 开口前先读 \${CFG.home}\\\\_回复风格.md；要记备忘或定提醒时读 \${CFG.home}\\\\_备忘与提醒.md]\`,
];`,
  '风格固定行',
);

bot = replaceOnce(bot, '\n    `[现在是 ${day} 深夜。把今天跟主人聊的要事写成一篇要事记录，追加到 D:\\\\QQWhale\\\\home\\\\要事.md：]`,', '\n    `[现在是 ${day} 深夜。把今天跟主人聊的要事写成一篇要事记录，追加到 ${CFG.home}\\\\要事.md：]`,', '日记路径');

// 注释里剩下的本机路径、群号例子：一律改写成通用说法
bot = replaceOnce(bot, '\nasync function transcribeAudio(src) {\n  const work', '\nasync function transcribeAudio(src) {\n  if (!CFG.ffmpeg || !CFG.voiceWhisper) return null; // 没配 ffmpeg/whisper 就别折腾，收语音只留占位\n  const work', '收语音转写开关');

bot = replaceOnce(bot, '![](D:\\QQWhale\\home\\xxx.png)', '![](home\\xxx.png)', '发图注释');
bot = replaceOnce(bot, '格式 {"groups":[1130752723],"until":"2026-10-18T21:30:00+08:00"}；', '格式 {"groups":[群号],"until":"2026-11-01T21:30:00+08:00"}；', '临时群白名单注释');
bot = replaceOnce(bot, 'D:\\QQWhale\\tools\\tmp 与\n      //      %LOCALAPPDATA%\\Temp 下的新目录实测都挂。', '工作区外的临时目录与\n      //      %LOCALAPPDATA%\\Temp 下的新目录实测都挂。', '临时目录注释');
bot = replaceOnce(bot, '在它自己那条命令里指到**已验过的** D:\\QQWhale\\home\\tools\\_e2e\\tmp（见 _看视频工具.md）。', '在它自己那条命令里指到**已验过的**一个能建目录的位置（比如 %TEMP%\\whale-tmp）。', '临时目录注释二');

bot = replaceOnce(
  bot,
  "const BOT_BUILD = '2026-10-19-1725-turnlog';",
  "const BOT_BUILD = 'kit-1.0';",
  '构建标记',
);

fs.writeFileSync(path.join(DIST, 'bot', 'whale-bot.mjs'), bot, 'utf8');
fs.copyFileSync(LIVE_OUTBOX, path.join(DIST, 'bot', 'outbox.mjs'));
ok(`whale-bot 已脱敏（${before} → ${bot.length} 字节）`);

// 语法自检：只编译，不启动，不连网
import { execFileSync } from 'node:child_process';
try {
  execFileSync(process.execPath, ['--check', path.join(DIST, 'bot', 'whale-bot.mjs')], { stdio: 'pipe' });
  ok('语法自检通过');
} catch (e) {
  fail('改完的 whale-bot 语法不过：' + String(e.stderr || e.message).slice(0, 500));
}

// ---------- 5. 程序与模板 ----------
for (const dir of ['bin', 'panel']) {
  fs.cpSync(path.join(SRC, dir), path.join(DIST, dir), { recursive: true });
}
fs.copyFileSync(path.join(SRC, 'config.example.json'), path.join(DIST, 'config.example.json'));
// 不预置 config.json：留空，「启动.bat」才会先拉一遍设置向导；预置一份占位配置会被当成"已设置好"。
for (const f of ['启动.bat', '设置.bat', '打开面板.bat', 'README.md', '说明书.md', '新手引导.md']) {
  const src = path.join(SRC, f);
  must(fs.existsSync(src), `缺 ${f}`);
  fs.copyFileSync(src, path.join(DIST, f));
}
ok('启动器 / 面板 / 文档已就位');

// ---------- 6. 脱敏校验 ----------
const BAD = [
  [/3118384201|869284090|1130752723|1678121574|2284844598/, '私人 QQ 号'],
  [/a8f3392dd46e1d856f4ed72e87a5d92a/, 'OneBot 令牌'],
  [/QQWhale/i, '本机绝对路径 D:\\QQWhale'],
  [/C:\\+Users\\+86928/i, '本机用户目录'],
  [/DSHWORK/i, 'DSHWORK 路径'],
  [/8367|lobster/i, '反代通道'],
  [/虞曦|七弦吉他手|小渊|星渊/, '私人称呼'],
  [/sk-[A-Za-z0-9]{10,}/, '疑似 API key'],
];
const hits = [];
function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (/\.(mjs|js|json|md|bat|ps1|html|css|txt|yml)$/i.test(d.name)) {
      const t = fs.readFileSync(p, 'utf8');
      for (const [re, label] of BAD) {
        const m = t.match(re);
        if (m) hits.push(`${path.relative(DIST, p)} · ${label} · ${m[0].slice(0, 40)}`);
      }
    }
  }
}
walk(DIST);
if (hits.length) {
  fail('脱敏校验没过：\n  ' + hits.join('\n  '));
}
ok('脱敏校验零命中');

// ---------- 7. 统计 ----------
let files = 0;
let bytes = 0;
(function count(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) count(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(DIST);
console.log(`\n✓ 打包完成：${files} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB -> ${DIST}`);
