/**
 * 起点极简 · 静态自检脚本（纯 Node，无需依赖）
 *
 *   node tools/validate.mjs
 *
 * 检查内容：
 *   1. manifest.json 是否为合法 JSON、关键字段是否齐全
 *   2. manifest 引用的所有文件是否存在
 *   3. 全部 JS 文件是否能通过语法解析（vm.Script 只解析不执行）
 *   4. 危险模式自检：阅读页是否被正确排除、是否误用 broad 的 "game" 文本匹配
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

let errors = 0;
let warnings = 0;
const fail = (m) => {
  errors++;
  console.log(`  ✗  ${m}`);
};
const warn = (m) => {
  warnings++;
  console.log(`  !  ${m}`);
};
const ok = (m) => console.log(`  ✓  ${m}`);

/* ---------- 1. manifest ---------- */
console.log('\n[1/4] manifest.json');
const mfPath = path.join(ROOT, 'manifest.json');
let mf;
try {
  mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  ok('JSON 解析通过');
} catch (e) {
  fail(`JSON 解析失败：${e.message}`);
  process.exit(1);
}

if (mf.manifest_version !== 3) fail('manifest_version 必须是 3');
else ok('manifest_version = 3');

for (const k of ['name', 'version', 'description', 'action', 'content_scripts', 'icons']) {
  if (!mf[k]) fail(`缺少必需字段：${k}`);
}
if (!mf.permissions || !mf.permissions.includes('storage')) fail('缺少 storage 权限');
else ok('permissions 含 storage');
if (mf.permissions && mf.permissions.includes('tabs'))
  warn('声明了 tabs 权限（本项目通过 host_permissions 读取标签页 URL，无需 tabs）');

/* ---------- 2. 引用文件 ---------- */
console.log('\n[2/4] manifest 引用的文件');
const refs = new Set();
const pushRef = (p) => p && refs.add(p);
Object.values(mf.icons || {}).forEach(pushRef);
Object.values((mf.action && mf.action.default_icon) || {}).forEach(pushRef);
pushRef(mf.action && mf.action.default_popup);
pushRef(mf.background && mf.background.service_worker);
(mf.content_scripts || []).forEach((cs) => {
  (cs.js || []).forEach(pushRef);
  (cs.css || []).forEach(pushRef);
});
(mf.web_accessible_resources || []).forEach((w) => (w.resources || []).forEach(pushRef));

for (const r of [...refs].sort()) {
  if (existsSync(path.join(ROOT, r))) ok(rel(path.join(ROOT, r)));
  else fail(`引用的文件不存在：${r}`);
}

/* ---------- 3. JS 语法 ---------- */
console.log('\n[3/4] JS 语法解析');
const jsFiles = [...refs].filter((r) => r.endsWith('.js'));
for (const f of jsFiles.sort()) {
  const src = readFileSync(path.join(ROOT, f), 'utf8');
  try {
    new vm.Script(src, { filename: f });
    ok(rel(path.join(ROOT, f)));
  } catch (e) {
    fail(`${f} 语法错误：${e.message}`);
  }
}

/* ---------- 4. 安全 / 约定自检 ---------- */
console.log('\n[4/4] 关键约定');

// 4.1 阅读页必须被排除
const excludes = (mf.content_scripts || []).flatMap((cs) => cs.exclude_matches || []);
const needExclude = [
  '*://read.qidian.com/*',
  '*://vipreader.qidian.com/*',
  '*://*.qidian.com/chapter/*'
];
for (const n of needExclude) {
  if (excludes.includes(n)) ok(`已排除阅读页：${n}`);
  else fail(`缺少 exclude_matches：${n}`);
}

// 4.2 每个 content_scripts 条目都必须带 exclude
for (const [i, cs] of (mf.content_scripts || []).entries()) {
  if (!(cs.exclude_matches || []).length) fail(`content_scripts[${i}] 没有 exclude_matches`);
  if (cs.all_frames) warn(`content_scripts[${i}] 开启了 all_frames，可能影响 iframe 内的阅读器`);
}

// 4.3 theme.css：注释必须配对（注释被提前闭合会让后面的规则整块失效）
const css = readFileSync(path.join(ROOT, 'src/theme.css'), 'utf8');
const openCount = (css.match(/\/\*/g) || []).length;
const closeCount = (css.match(/\*\//g) || []).length;
if (openCount !== closeCount) {
  fail(`theme.css 注释定界符不配对：/* 出现 ${openCount} 次，*/ 出现 ${closeCount} 次（`+'常见原因：注释正文里写了 `*/`）');
} else {
  ok(`theme.css 注释定界符配对（各 ${openCount} 个）`);
}

// 按浏览器语义剥离注释（/* 到下一个 */），再逐个提取规则
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('/*', i);
    if (open < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf('*/', open + 2);
    if (close < 0) break;
    out += ' ';
    i = close + 2;
  }
  return out;
}

function scanRules(text) {
  const clean = stripComments(text);
  const rules = [];
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf('{', i);
    if (open < 0) break;
    const sel = clean.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') depth--;
      j++;
    }
    const body = clean.slice(open + 1, j - 1);
    if (/^@(media|supports|layer|container)/.test(sel)) rules.push(...scanRules(body));
    else rules.push({ sel, body });
    i = j;
  }
  return rules;
}

const rules = scanRules(css);
const norm = (s) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
ok(`theme.css 解析出 ${rules.length} 条规则`);

// 4.4 设计令牌必须挂在正确的选择器上
const TOKEN_SEL = "html[data-qd-minimal='on']";
const tokenRule = rules.find((r) => norm(r.sel) === TOKEN_SEL);
if (!tokenRule) {
  fail(`找不到设计令牌规则 ${TOKEN_SEL}（选择器被污染，通常是注释提前闭合）`);
} else if (!/--qd-bg\s*:/.test(tokenRule.body)) {
  fail('设计令牌规则里没有 --qd-bg');
} else {
  ok(`设计令牌规则选择器正确（${TOKEN_SEL}）`);
}

const requiredTokens = [
  '--qd-accent', '--qd-accent-hover', '--qd-accent-soft', '--qd-bg', '--qd-surface',
  '--qd-surface-2', '--qd-surface-3', '--qd-header-bg', '--qd-border', '--qd-border-2',
  '--qd-text', '--qd-text-2', '--qd-text-3', '--qd-shadow-1', '--qd-shadow-2', '--qd-focus',
  '--qd-r-xs', '--qd-r-sm', '--qd-r-md', '--qd-r-lg', '--qd-r-pill', '--qd-w', '--qd-font',
  '--qd-ease'
];
const tokenOwners = new Map();
for (const r of rules) {
  for (const m of r.body.matchAll(/(--qd-[a-z0-9-]+)\s*:/g)) {
    if (!tokenOwners.has(m[1])) tokenOwners.set(m[1], []);
    tokenOwners.get(m[1]).push(norm(r.sel));
  }
}
const missingTokens = requiredTokens.filter((t) => !tokenOwners.has(t));
if (missingTokens.length) fail(`缺少令牌定义：${missingTokens.join(', ')}`);
else ok(`令牌定义齐全（${requiredTokens.length} 个）`);

// 半径令牌只能出现在基础块，日夜主题必须共用同一套刻度
for (const t of ['--qd-r-xs', '--qd-r-sm', '--qd-r-md', '--qd-r-lg', '--qd-r-pill']) {
  const owners = [...new Set(tokenOwners.get(t) || [])];
  if (owners.length > 1) fail(`${t} 被多处定义：${owners.join(' / ')}`);
}
ok('半径令牌只在基础块定义，日夜共用同一套刻度');

// 未定义令牌引用 = 该声明会在 computed-value 阶段失效（本次已踩过的坑）
const usedVars = new Set();
for (const r of rules) {
  for (const m of r.body.matchAll(/var\(\s*(--qd-[a-z0-9-]+)/g)) usedVars.add(m[1]);
}
const undefVars = [...usedVars].filter((v) => !tokenOwners.has(v));
if (undefVars.length) fail(`引用了未定义的令牌（声明会静默失效）：${undefVars.join(', ')}`);
else ok(`所有 var(--qd-*) 引用（${usedVars.size} 个）都有定义`);

// 4.5 作用域收窄 + 选择器卫生
const cjkSel = rules.filter((r) => /[\u4e00-\u9fff]/.test(r.sel));
if (cjkSel.length) {
  for (const r of cjkSel.slice(0, 5)) fail(`选择器里出现中文（注释提前闭合的典型症状）：${r.sel.slice(0, 90)}`);
} else {
  ok('选择器中无中文残留');
}

const unscoped = rules.filter((r) => !norm(r.sel).includes('data-qd-minimal'));
if (unscoped.length) {
  for (const r of unscoped.slice(0, 8)) fail(`存在未收窄作用域的选择器：${norm(r.sel).slice(0, 90)}`);
  if (unscoped.length > 8) fail(`…… 另有 ${unscoped.length - 8} 处`);
} else {
  ok(`theme.css 全部 ${rules.length} 条规则均收在 html[data-qd-minimal="on"] 之下`);
}

// 4.6 真实站点事故的两个回归防线
//     (a) 禁止对裸 a 元素做全局颜色覆盖 —— 上一版就是这样把 .main-nav（#3e3d43 深灰底白字）
//         里的链接染成深灰的，整条导航看不见
const bareLinkColor = rules.filter(
  (r) =>
    /color\s*:/.test(r.body) &&
    r.sel
      .split(',')
      .some((part) => /^html\[data-qd-minimal='on'\]\s+a(\b|:|$)/.test(norm(part)))
);
if (bareLinkColor.length) {
  for (const r of bareLinkColor) fail(`禁止对裸 a 做全局颜色覆盖（深色底区域会变成看不清）：${norm(r.sel).slice(0, 80)}`);
} else {
  ok('没有对裸 a 的全局颜色覆盖（深色底区域安全）');
}

//     (b) .book-list 是 216px 宽的紧凑文字榜，绝不能被改成网格/卡片
const bookListBroken = rules.filter(
  (r) => /book-list/.test(r.sel) && /display\s*:\s*(grid|inline-grid)/.test(r.body)
);
if (bookListBroken.length) {
  for (const r of bookListBroken) fail(`.book-list 被改成了网格布局（首页会整块错位）：${norm(r.sel).slice(0, 80)}`);
} else {
  ok('.book-list 未被改成网格布局（首页三栏紧凑榜安全）');
}

//     (c) 真实页游入口必须在 CSS 与 JS 两侧都被处理
const realGameSelectors = ['#topGameOp', 'li#game-web'];
for (const s of realGameSelectors) {
  const inCss = css.includes(s);
  const inJs = readFileSync(path.join(ROOT, 'src/content.js'), 'utf8').includes(s);
  if (inCss && inJs) ok(`真实页游入口已处理：${s}`);
  else fail(`真实页游入口未完整处理：${s}（css=${inCss} js=${inJs}）`);
}

// 4.7 页游文本匹配 + 阅读页守卫
const content = readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
if (/GAME_TEXT\s*=\s*\/\^\(/.test(content)) ok('页游文本匹配使用锚定的精确匹配');
else fail('GAME_TEXT 未使用 ^...$ 锚定，存在误伤「游戏」分类链接的风险');
if (!/chapter/i.test(content) || !/isReaderUrl/.test(content))
  fail('content.js 缺少 /chapter/ 运行时守卫');
else ok('content.js 含 /chapter/ 运行时守卫（双保险）');

// 4.8 配置默认值一致（showToggle 只影响 DOM，不需要在 early.js 出现）
const early = readFileSync(path.join(ROOT, 'src/early.js'), 'utf8');
const popup = readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
const earlyKeys = ['enabled', 'theme', 'removeGames', 'hideAds'];
const allKeys = [...earlyKeys, 'showToggle'];
const missing = allKeys.filter((k) => !popup.includes(k) || !content.includes(k));
const missingEarly = earlyKeys.filter((k) => !early.includes(k));
if (missing.length || missingEarly.length) {
  warn(
    `默认配置项未对齐：content/popup 缺 ${missing.join(', ') || '无'}；early 缺 ${
      missingEarly.join(', ') || '无'
    }`
  );
} else {
  ok('默认配置项在 early.js / content.js / popup.js 中一致');
}

// 4.9 已下线的开关不应残留在代码里
if (/layoutGrid|data-qd-grid/.test(css + content + early + popup)) {
  warn('layoutGrid / data-qd-grid 已被移除，但代码里仍有残留');
} else {
  ok('已下线的 layoutGrid 开关无残留');
}

// 4.10 夜间自适应（未知模板）：标记必须两侧接线，且只能在夜间生效
const cssHasLight = /\[data-qd-light='1'\]/.test(css);
const jsHasLight = /data-qd-light/.test(content);
if (cssHasLight && jsHasLight) ok('夜间自适应标记在 CSS / JS 两侧都已接线');
else fail(`夜间自适应标记未接线（css=${cssHasLight} js=${jsHasLight}）`);

const notGated = rules.filter(
  (r) => /data-qd-light|data-qd-text/.test(r.sel) && !/data-qd-resolved='dark'/.test(r.sel)
);
if (notGated.length) {
  for (const r of notGated.slice(0, 5)) fail(`自适应规则未限定夜间：${norm(r.sel).slice(0, 90)}`);
} else {
  ok('自适应规则全部限定在 [data-qd-resolved="dark"] 之下（日间不生效）');
}

// 自适应只应碰颜色，绝不能改布局
const adaptLayout = rules.filter(
  (r) =>
    /data-qd-light|data-qd-text/.test(r.sel) &&
    /(display|position|float|width|height|margin|padding)\s*:/.test(r.body)
);
if (adaptLayout.length) {
  for (const r of adaptLayout.slice(0, 5)) fail(`自适应规则不应改布局属性：${norm(r.sel).slice(0, 90)}`);
} else {
  ok('自适应规则只改颜色，未触碰任何布局属性');
}

// 4.11 书架封面：地址规律必须与实抓一致（qdbimg/349573 为常量，20/20 验证过）
if (/COVER_BASE\s*=\s*'https:\/\/bookcover\.yuewen\.com\/qdbimg\/349573\/'/.test(content)) {
  ok('书架封面地址使用实抓验证过的图床规律');
} else {
  fail('书架封面地址常量与实抓规律不一致');
}
if (/\.qd-cover\b/.test(css)) ok('.qd-cover 样式已定义');
else fail('缺少 .qd-cover 样式');
if (/isBookcasePage/.test(content)) ok('书架封面只在 /bookcase 路径生效');
else fail('书架封面缺少路径限制');

// 4.12 源文件不得带 UTF-8 BOM。
//     踩过一次：用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 改版本号会写入 BOM，
//     manifest.json 直接解析失败（扩展也就装不上）。
const bomFiles = [];
for (const f of [
  'manifest.json',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'src/theme.css',
  'src/content.js',
  'src/early.js',
  'src/background.js'
]) {
  const buf = readFileSync(path.join(ROOT, f));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bomFiles.push(f);
}
if (bomFiles.length) fail(`以下文件带 UTF-8 BOM，会导致清单解析失败：${bomFiles.join(', ')}`);
else ok('所有源文件均无 UTF-8 BOM');

const bgSrc = readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
// 4.14 快捷键已按用户要求彻底移除（Alt+Shift+T 在 Edge 侧被占用，扩展改不动）。
//      要求：manifest 无 commands、代码无 chrome.commands、界面无快捷键提示。
const allSrc = [css, content, early, popup, bgSrc, readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8')].join('\n');
if (/Alt\+Shift\+T|Alt \+ Shift \+ T|chrome\.commands|suggested_key/.test(allSrc) ||
    /"commands"\s*:/.test(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))) {
  fail('仍残留快捷键定义或提示（应已彻底移除）');
} else {
  ok('快捷键已彻底移除（无 commands / 无 chrome.commands / 无界面提示）');
}
// 4.15 「整行铺满」的品牌行规则只能作用于首页。
//      真实事故：它是全局的，频道页的 .logo-wrap 在图片横幅内部，
//      于是把整条横幅盖成一条纯色带（用户截图里的「突兀纯色横幅」）。
if (/html\[data-qd-minimal='on'\] \.logo-wrap \{/.test(css)) {
  fail('.logo-wrap 铺满规则没有限定首页，会在频道页盖住图片横幅');
} else {
  ok('.logo-wrap 铺满规则已限定首页（[data-qd-home]）');
}
if (/data-qd-home/.test(content) && /data-qd-home/.test(early)) {
  ok('首页标记在 early.js / content.js 两侧都已接线');
} else {
  fail('首页标记未接线（early.js 与 content.js 都要维护）');
}
// 4.16 主脚本（含 DOM 观察器 / 剪贴板 / 导出）必须完全排除阅读页。
//      阅读页现在零注入（阅读界面功能已按用户要求移除），这条防线保留。
const mainEntry = (mf.content_scripts || []).find((c) => (c.js || []).indexOf('src/content.js') !== -1);
const exMain = (mainEntry && mainEntry.exclude_matches) || [];
if (exMain.some((m) => m.indexOf('read.qidian.com') !== -1) && exMain.some((m) => m.indexOf('chapter') !== -1)) {
  ok('主脚本完全排除阅读页（阅读页零注入）');
} else {
  fail('主脚本没有排除阅读页，防盗版风险');
}

/* ---------- 汇总 ---------- */
console.log(
  `\n结果：${errors === 0 ? '通过' : '未通过'}　错误 ${errors} 项，提醒 ${warnings} 项\n`
);
process.exit(errors === 0 ? 0 : 1);
