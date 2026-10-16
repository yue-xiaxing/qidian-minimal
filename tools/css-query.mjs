/**
 * 起点极简 · 站点样式查询器
 *
 *   node tools/css-query.mjs <css文件> <选择器关键字1> [关键字2 ...]
 *
 * 从（可能是压缩成一行的）站点 CSS 里按关键字反查规则，用来确认真实配色与尺寸。
 * 只做字符串级切分，够用即可。
 */
import { readFileSync } from 'node:fs';

const [, , file, ...keys] = process.argv;
if (!file || !keys.length) {
  console.error('用法：node tools/css-query.mjs <css文件> <关键字...>');
  process.exit(1);
}

const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 顺序切分：selector { body }
const rules = [];
let i = 0;
let buf = '';
while (i < css.length) {
  const ch = css[i];
  if (ch === '{') {
    let depth = 1;
    let j = i + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    rules.push({ sel: buf.trim(), body: css.slice(i + 1, j - 1).trim() });
    buf = '';
    i = j;
    continue;
  }
  if (ch === '}') {
    buf = '';
    i++;
    continue;
  }
  buf += ch;
  i++;
}

const seen = new Set();
for (const k of keys) {
  const re = new RegExp(k, 'i');
  const hits = rules.filter((r) => re.test(r.sel));
  console.log(`\n########## 关键字 ${k} 命中 ${hits.length} 条 ##########`);
  for (const r of hits) {
    const line = `${r.sel} { ${r.body} }`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.log(line.length > 900 ? line.slice(0, 900) + ' …' : line);
  }
}
