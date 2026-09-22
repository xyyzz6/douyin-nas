/* 回归守卫：群晖那种「根目录就是 WebDAV」（urlPath 为空）的场景，
 * 修复前后算出来的 URL 必须**逐字相同** —— 修 CD2 时绝不能碰坏原本能用的机器。
 * 跑法： node _tools/dav-regress-synology.js
 */
const fs = require('fs');
const srv = fs.readFileSync('server.js', 'utf8');

function grab(name, src) {
  const i = src.indexOf('function ' + name + '(');
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1);
}
const names = ['normAbs', 'encPath', 'pathPrefix', 'splitUrl', 'mountAbs', 'davUrlAbs'];
const ctx = new Function(names.map((n) => grab(n, srv)).join('\n') + '\nreturn { ' + names.join(', ') + ' };')();

// 旧实现（修复前）：origin + encPath(absPath)，没有 urlPath 概念
const OLD = (url, p) => new URL(url).origin + ctx.encPath(ctx.normAbs(p));

const SYNO = 'http://192.168.1.100:5005';
const cases = [
  ['根目录',        '/'],
  ['一层',          '/Photos'],
  ['两层',          '/video/2024'],
  ['中文目录',      '/电影/2024年'],
  ['带空格',        '/我的 视频'],
  ['中文文件名',    '/电影/a.mp4'],
];
let diff = 0;
console.log('群晖根挂载（urlPath 为空）—— 新旧实现输出对比');
for (const [n, p] of cases) {
  const now = ctx.davUrlAbs({ url: SYNO }, p, false);
  const old = OLD(SYNO, p);
  const same = now === old;
  if (!same) diff++;
  console.log((same ? '  ✅' : '  ❌') + ' ' + n);
  if (!same) { console.log('       旧: ' + old); console.log('       新: ' + now); }
}
console.log(diff ? `\n❌ ${diff} 处行为改变（不该变！）` : `\n✅ ${cases.length}/${cases.length} 与修复前完全一致 —— 群晖不受影响`);
