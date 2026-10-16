/**
 * 起点极简 · 真实 DOM 轮廓提取器
 *
 *   node tools/dom-outline.mjs <dump.html> [最大深度] [关键字过滤]
 *
 * 用 headless Edge 的 --dump-dom 抓下真实页面后，用这个脚本把「有 class/id 的元素」
 * 打成缩进轮廓，方便反推真实选择器（不依赖任何第三方解析库）。
 */
import { readFileSync } from 'node:fs';

const [, , file, depthArg, filterArg] = process.argv;
if (!file) {
  console.error('用法：node tools/dom-outline.mjs <dump.html> [最大深度] [关键字]');
  process.exit(1);
}
const maxDepth = Number(depthArg || 6);
const filter = filterArg ? new RegExp(filterArg, 'i') : null;

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);

const html = readFileSync(file, 'utf8');
const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const stack = [];
let depth = 0;
let out = [];
let m;

function attrsOf(raw) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let a;
  while ((a = re.exec(raw))) out[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
  return out;
}

function desc(tag, attrs) {
  let s = tag;
  if (attrs.id) s += `#${attrs.id}`;
  if (attrs.class) {
    const cls = attrs.class.trim().split(/\s+/).slice(0, 4).join('.');
    s += `.${cls}`;
  }
  return s;
}

while ((m = tagRe.exec(html))) {
  const closing = m[1] === '/';
  const tag = m[2].toLowerCase();
  const raw = m[3] || '';
  const selfClose = m[4] === '/';

  if (closing) {
    // 回退到匹配的开始标签
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        depth = stack.length;
        break;
      }
    }
    continue;
  }

  const attrs = attrsOf(raw);
  const line = desc(tag, attrs);
  const hit = !filter || filter.test(line);

  if (hit && depth < maxDepth && !/^(script|style|noscript|template)$/.test(tag)) {
    out.push('  '.repeat(depth) + line);
  }

  if (!VOID.has(tag) && !selfClose) {
    // script/style 内容直接吃掉，避免内容里的 < 造成误判
    if (tag === 'script' || tag === 'style') {
      const close = html.indexOf(`</${tag}`, tagRe.lastIndex);
      if (close !== -1) tagRe.lastIndex = close;
      continue;
    }
    stack.push({ tag });
    depth = stack.length;
  }
}

console.log(out.join('\n'));
console.log('\n---- 行数：' + out.length + ' ----');
