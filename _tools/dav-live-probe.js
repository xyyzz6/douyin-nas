/* 用真实的 server.js 代码（不是模拟）打真实 CD2 —— 这是最硬的验证 */
const path = require('path');
const ROOT = process.cwd();
const srv = require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// 从 server.js 里抠出 davUrlAbs / splitUrl / pathPrefix / normAbs / encPath 真身
function grab(name, src) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('没找到 ' + name);
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1);
}
// 把 5 个函数的**源码**拼进同一个函数体（保持函数声明语义，彼此可见），
// 再把它们导出来 —— 这样跑的就是 server.js 里正在用的那份代码。
const names = ['normAbs', 'encPath', 'pathPrefix', 'splitUrl', 'mountAbs', 'davUrlAbs'];
const body = names.map((n) => grab(n, srv)).join('\n')
  + '\nreturn { ' + names.join(', ') + ' };';
const ctx = new Function(body)();
const { davUrlAbs } = ctx;

const CFG = { url: 'http://192.168.1.100:19798/dav' };
const targets = [
  ['服务根（登录探的就是这个）', '/dav'],
  ['子目录',                    '/dav/115open'],
  ['子目录（目录形态）',        '/dav/115open'],
];
console.log('=== 修复后代码给 CD2 算出的地址 ===');
for (const [n, p] of targets) {
  console.log(' ', n.padEnd(22), davUrlAbs(CFG, p, n.includes('目录形态')));
}
// 旧实现是写死的「origin + encPath(absPath)」——它**没有** urlPath 这个概念，
// 所以这里不能拿修好的 splitUrl 去反推，直接按旧逻辑硬算。
const OLD = (url, p) => new URL(url).origin + ctx.encPath(p);
console.log('\n=== 旧代码（只取 origin，硬算）会给出的地址 ===');
console.log('  ', OLD(CFG.url, '/dav/115open'), '  ← 丢 /dav');

// 真打一发
(async () => {
  console.log('\n=== 实际请求验证 ===');
  const probe = async (url, label) => {
    try {
      const r = await fetch(url, { method: 'PROPFIND', headers: { Depth: '1' } });
      console.log('  ' + String(r.status).padEnd(4), label, '\n      ', url);
      return r.status;
    } catch (e) { console.log('  ERR ', label, e.message); return 0; }
  };
  const ok   = await probe(davUrlAbs(CFG, '/dav/115open', true), '新代码');
  const oldu = 'http://192.168.1.100:19798/115open';   // 旧代码丢 /dav 后打的就是这个
  const bad  = await probe(oldu, '旧代码');
  console.log('\n结论：', ok === 401 ? '✅ 新代码打到正确的 WebDAV 端点（401 = 端点对，只差凭据）'
    : '❌ 新代码仍不对（' + ok + '）');
  console.log('      ', bad === 405 ? '✅ 旧代码确实打到了管理界面（405），与诊断完全一致'
    : '（旧代码返回 ' + bad + '）');
})();
