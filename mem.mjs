#!/usr/bin/env node
/**
 * 深海灯志 · 最小版（六个件：存 切 取 拼 写 忘）
 * 零依赖，Node 18+。用法见 README.md。
 *
 *   node mem.mjs build              重建索引
 *   node mem.mjs query "问题"       取最相关三段，拼成上下文块（≤800 字）
 *   node mem.mjs add 学习 "内容"     追加一条带日期的记忆
 *   node mem.mjs forget             把 90 天没改过新内容的主题标成「搁着」
 *   node mem.mjs list               看所有主题文件
 *   node mem.mjs synonyms           看同义词表（想加词就改文件里那张表）
 *   node mem.mjs selfcheck          体检：几个主题、几段、哪些太久没记、索引过没过期
 *
 * 0.3.1 版（2026-10-22）：加 selfcheck。0.3 版（2026-10-22）改了两处：查询加同义词扩展、停用词补疑问虚词。
 */

/*
 * Copyright (C) 2026 星渊
 *
 * 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证
 * （第 3 版，或你选择的任何更新版本）的条款，再分发和／或修改它。
 *
 * 本程序按「原样」分发，不附带任何担保；连适销性或特定用途适用性的默示担保也没有。
 * 详见 GNU 通用公共许可证第 15、16 条。
 *
 * 你应当已随本程序收到 GNU 通用公共许可证的副本；没有的话见
 * <https://www.gnu.org/licenses/>。
 *
 * 改过的版本必须显著标明你改动过、并给出改动日期（许可证第 5 条 a 款）；
 * 改了还往外发的，整个作品仍然按这份许可证走，不许闭源。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MEM_DIR = path.join(ROOT, 'memory');
const CACHE_DIR = path.join(ROOT, '.cache');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');

const TOP_K = 3;          // 一次取几段
const MAX_CHARS = 800;    // 拼出来的上下文硬上限
const STALE_DAYS = 90;    // 多久没新内容算「搁着」
const K1 = 1.2, B = 0.75; // BM25 参数

const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '在', '和', '就',
  '都', '也', '还', '这', '那', '有', '不', '吗', '呢', '吧', '啊', '呀', '么', '一个',
  // 0.3 补的疑问虚词：问句里这些词每回都出现，留着只会把不相关的段落拉上来
  '什么', '怎么', '怎样', '为什', '为啥', '多少', '哪个', '哪些', '哪一', '哪里',
  '哪儿', '几个', '如何', '是否', '可以', '能不', '这个', '那个', '我们', '你们',
  '他们', '它们', '自己', '现在', '时候', '问题', '东西', '事情', '觉得', '知道',
  '告诉', '的话', '一下', '就是', '这样', '那样', '还有', '已经', '一直', '比较',
  '非常', '真的', '但是', '因为', '所以', '如果', '虽然', '然后', '其实', '应该']);

// ---------- 存 ----------

function ensureDirs() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
}

function listFiles() {
  if (!fs.existsSync(MEM_DIR)) return [];
  return fs.readdirSync(MEM_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .map(d => {
      const full = path.join(MEM_DIR, d.name);
      return { rel: d.name, path: full, mtime: Math.round(fs.statSync(full).mtimeMs) };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
}

// ---------- 切 ----------

// 按空行切段；纯标题行不进索引，但保留在文件里当目录。
function splitParagraphs(raw) {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(s => s && !/^#+\s/.test(s.replace(/\n/g, ' ').trim()) && !/^\[搁着[:：]/.test(s));
}

// ---------- 取 ----------

// 中文二字切词 + 英文/数字词。单字不成词，免得噪音太多。
function tokenize(text) {
  const out = [];
  const norm = text.toLowerCase();
  for (const m of norm.matchAll(/[a-z0-9_]+/g)) out.push(m[0]);
  for (const m of norm.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  }
  return out.filter(t => !STOP.has(t));
}

// 同义词表：一个概念配几种常用来问它的说法。
// 中文按二字切词只认字面，「余额」和「还剩多少」一个词都对不上，靠这张小表把两边接上。
// 想加词直接往组里塞；组里是「同一个概念的不同说法」，不求严格同义。
const SYNONYMS = [
  ['余额', '还剩多少', '剩多少钱', '剩下多少', '额度'],
  ['花销', '花费', '支出', '花了多少'],
  ['没钱', '不够花', '余额不足', '钱不够'],
  ['时间', '几点', '钟点', '日期', '哪天', '几号'],
  ['学习', '复习', '备考', '看书', '做题', '念书'],
  ['考试', '测验', '大考', '笔试'],
  ['成绩', '分数', '排名', '考了多少'],
  ['压力', '焦虑', '紧张', '好烦', '难受', '崩溃'],
  ['开心', '高兴', '快乐', '心情好'],
  ['生气', '火大', '不爽', '恼火'],
  ['喜欢', '偏好', '爱好', '在意'],
  ['讨厌', '不喜欢', '反感', '烦人'],
  ['工作', '上班', '职业', '岗位', '打工'],
  ['睡觉', '睡了', '困了', '熬夜', '失眠'],
  ['吃饭', '吃了', '外卖', '伙食'],
  ['计划', '安排', '日程', '排表', '排期'],
  ['提醒', '记得', '别忘了', '记住'],
  ['名字', '称呼', '叫什么', '昵称'],
  ['电脑', '机器', '本机', '设备'],
  ['错误', '报错', '出错', '失败', 'bug', '出问题', '有问题'],
  ['修复', '修好', '解决', '搞定'],
  ['手机', '电话', '号码'],
  ['密码', '口令', '密钥', 'key'],
  ['住处', '住哪', '宿舍', '家里'],
  ['身体', '健康', '生病', '不舒服'],
  ['朋友', '好友', '熟人'],
  ['课程', '上课', '课件', '课表'],
  ['文件', '文档', '资料', '文件夹'],
  ['记录', '记下来', '写下来', '笔记'],
];
const SYN_WEIGHT = 0.6; // 同义词命中的分打个折，别盖过原词

// 每组先把词切好存成 token 集合；查询命中组里任一词，才把整组接上
const SYN_GROUPS = SYNONYMS.map(group => {
  const set = new Set();
  for (const word of group) for (const t of tokenize(word)) set.add(t);
  return set;
});

// 查询扩展：原词算 base，组里没出现过的词算 extras
function expandQuery(q) {
  const base = [...new Set(tokenize(q))];
  const extras = new Set();
  for (const group of SYN_GROUPS) {
    if (!base.some(t => group.has(t))) continue;
    for (const t of group) if (!base.includes(t)) extras.add(t);
  }
  return { base, extras: [...extras] };
}

function buildIndex() {
  const files = listFiles();
  const docs = [];
  const df = {};
  const now = Date.now();

  for (const f of files) {
    const raw = fs.readFileSync(f.path, 'utf8');
    const stale = (now - f.mtime) > STALE_DAYS * 86400 * 1000;
    splitParagraphs(raw).forEach((text, i) => {
      const tokens = tokenize(text);
      const seen = new Set(tokens);
      for (const t of seen) df[t] = (df[t] || 0) + 1;
      docs.push({ file: f.rel, idx: i + 1, text, len: tokens.length, mtime: f.mtime, stale });
    });
  }

  const index = { builtAt: new Date().toISOString(), files, df, docs };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), 'utf8');
  return index;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return buildIndex();
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const now = listFiles();
  const known = new Map(index.files.map(f => [f.rel, f.mtime]));
  const changed = now.length !== known.size || now.some(f => known.get(f.rel) !== f.mtime);
  return changed ? buildIndex() : index;
}

function rank(index, q) {
  const { base, extras } = expandQuery(q);
  const qTokens = [...base, ...extras];
  if (!qTokens.length || !index.docs.length) return { base, extras, hits: [] };
  const extraSet = new Set(extras);
  const N = index.docs.length;
  const avgdl = index.docs.reduce((s, d) => s + d.len, 0) / N;

  const hits = index.docs.map(d => {
    const tf = {};
    for (const t of tokenize(d.text)) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const t of qTokens) {
      const n = d.len ? (tf[t] || 0) : 0;
      if (!n) continue;
      const weight = extraSet.has(t) ? SYN_WEIGHT : 1;
      const idf = Math.log(1 + (N - (index.df[t] || 0) + 0.5) / ((index.df[t] || 0) + 0.5));
      score += weight * idf * (n * (K1 + 1)) / (n + K1 * (1 - B + B * (d.len / avgdl)));
    }
    return { ...d, score };
  }).filter(h => h.score > 0).sort((a, b) => b.score - a.score);

  return { base, extras, hits };
}

// ---------- 拼 ----------

function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function assemble(hits) {
  const parts = ['【本子里翻到的，只当参考，不是全部事实】'];
  let used = 0;
  for (const [i, h] of hits.entries()) {
    let body = h.text.replace(/\n+/g, ' ').trim();
    const head = `[${i + 1}] ${h.file} 第 ${h.idx} 段（改于 ${fmtDate(h.mtime)}）\n`;
    const room = MAX_CHARS - used - head.length;
    if (room <= 20) break;                     // 放不下就砍掉最不相关的那段
    if (body.length > room) body = body.slice(0, room - 1) + '…';
    parts.push(head + body);
    used += head.length + body.length + 1;
  }
  if (parts.length === 1) parts.push('（本子里没有相关的段落）');
  return parts.join('\n\n');
}

// ---------- 写 ----------

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function add(topic, text) {
  if (!topic || !text) throw new Error('用法：node mem.mjs add <主题> "内容"');
  const name = topic.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!name) throw new Error('主题名不能是空的');
  ensureDirs();
  const file = path.join(MEM_DIR, `${name}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${name}\n\n`, 'utf8');
  // 内容自己带了日期就不再补一个，免得一条两个日期
  const body = text.replace(/\s*\n\s*/g, ' ').trim();
  const line = (/^\d{4}-\d{2}-\d{2}/.test(body) ? body : `${stamp()} ${body}`) + '\n';
  // 重新有内容进来了，把「搁着」的标记摘掉
  const old = fs.readFileSync(file, 'utf8').replace(/^\[搁着[:：][^\n]*\]\n+/, '');
  fs.writeFileSync(file, old + (old.endsWith('\n\n') ? '' : '\n') + line, 'utf8');
  return file;
}

// ---------- 忘 ----------

function forget() {
  const now = Date.now();
  const rows = [];
  for (const f of listFiles()) {
    const days = Math.floor((now - f.mtime) / 86400000);
    if (days <= STALE_DAYS) continue;
    const st = fs.statSync(f.path);
    const raw = fs.readFileSync(f.path, 'utf8').replace(/^\uFEFF/, '');
    if (!/^\[搁着[:：]/.test(raw)) {
      fs.writeFileSync(f.path, `[搁着：${fmtDate(now)} 起，${days} 天没有新内容]\n\n` + raw, 'utf8');
      // 打标记不算「有新内容」，把修改时间改回去，否则下次建索引它又变成新鲜的
      fs.utimesSync(f.path, st.atime, st.mtime);
    }
    rows.push(`${f.rel}（${days} 天没新内容）`);
  }
  if (!rows.length) return `没有超过 ${STALE_DAYS} 天的主题，全都还在带。`;
  return `标成搁着、不再每轮带出来（文件还在，问到还能翻）：\n- ${rows.join('\n- ')}`;
}

// ---------- 体检 ----------

const SELFCHECK_DAYS = 14; // 超过这么多天没添新内容，就在体检里提一句

function selfcheck() {
  const files = listFiles();
  if (!files.length) {
    return 'memory/ 还是空的。先写一条：node mem.mjs add 主题 "内容"，再 node mem.mjs build。';
  }
  const now = Date.now();
  const idle = [];
  let stale = 0, paras = 0;
  for (const f of files) {
    const raw = fs.readFileSync(f.path, 'utf8').replace(/^\uFEFF/, '');
    const n = splitParagraphs(raw).length;
    paras += n;
    if (/^\[搁着[:：]/.test(raw)) { stale++; continue; }
    const days = Math.floor((now - f.mtime) / 86400000);
    if (days > SELFCHECK_DAYS) idle.push(`${f.rel}（${days} 天没新内容，${n} 段）`);
  }

  const out = [`${files.length} 个主题、${paras} 段；${stale} 个搁着、${files.length - stale} 个还在带。`];

  if (!fs.existsSync(INDEX_FILE)) {
    out.push('索引还没建过，query 第一次跑会自己建。');
  } else {
    const idxTime = fs.statSync(INDEX_FILE).mtimeMs;
    const newer = files.filter(f => f.mtime > idxTime).map(f => f.rel);
    if (newer.length) out.push(`索引比文件旧（${newer.join('、')} 改过），先 build 再查才准。`);
  }

  if (idle.length) {
    out.push(`这些超过 ${SELFCHECK_DAYS} 天没添新内容，想想是不是该记点什么：`);
    idle.forEach(r => out.push('- ' + r));
  } else {
    out.push(`没有超过 ${SELFCHECK_DAYS} 天没动的主题。`);
  }
  out.push('（体检只读文件、不调模型，不花钱；改隔几天算久，改上面 SELFCHECK_DAYS。）');
  return out.join('\n');
}

// ---------- 命令行 ----------

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'build': {
      const idx = buildIndex();
      const topics = new Set(idx.docs.map(d => d.file));
      console.log(`索引好了：${topics.size} 个主题、${idx.docs.length} 段、${Object.keys(idx.df).length} 个词条。`);
      break;
    }
    case 'query': {
      const q = rest.join(' ').trim();
      if (!q) throw new Error('用法：node mem.mjs query "你的问题"');
      const index = loadIndex();
      const { base, extras, hits } = rank(index, q);
      const keep = hits.filter(h => !h.stale).slice(0, TOP_K);
      const ext = extras.length ? `（同义扩展：${extras.slice(0, 8).join(' ')}）` : '';
      if (!keep.length) {
        console.log(`切词：${base.join(' ') || '（没有可用词）'}${ext}\n\n（本子里没有相关的段落，老实说没查到。）`);
        break;
      }
      if (process.env.MEM_DEBUG) console.log(`切词：${base.join(' ')}${ext}\n`);
      console.log(assemble(keep));
      break;
    }
    case 'add': {
      const file = add(rest[0], rest.slice(1).join(' '));
      console.log(`写进去了：${path.relative(ROOT, file)}`);
      break;
    }
    case 'forget':
      console.log(forget());
      break;
    case 'list': {
      const files = listFiles();
      if (!files.length) { console.log('memory/ 还是空的。'); break; }
      const now = Date.now();
      const lines = files.map(f => {
        const days = Math.floor((now - f.mtime) / 86400000);
        const paras = splitParagraphs(fs.readFileSync(f.path, 'utf8')).length;
        return `${f.rel}  ${paras} 段  ${days} 天前改过${days > STALE_DAYS ? '（搁着）' : ''}`;
      });
      console.log(lines.join('\n'));
      break;
    }
    case 'synonyms': {
      const lines = SYNONYMS.map((g, i) => `${String(i + 1).padStart(2, '0')}  ${g.join(' / ')}`);
      console.log(`同义词表（${SYNONYMS.length} 组）：\n${lines.join('\n')}\n\n命中组里任一词，整组都会拿来查，分数打 ${SYN_WEIGHT} 折。`);
      break;
    }
    case 'selfcheck':
      console.log(selfcheck());
      break;
    default:
      console.log('用法：node mem.mjs build | query "问题" | add 主题 "内容" | forget | list | synonyms | selfcheck');
      process.exitCode = cmd ? 1 : 0;
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`出错了：${err.message}`);
  process.exitCode = 1;
}
