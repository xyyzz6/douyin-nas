/* 用 server.js 的**真函数**，按 App 的调用姿势完整走一遍 CD2：
 * 登录探根 → 列目录 → 找视频文件夹 → 扫片库。
 * 跑法： node _tools/dav-cd2-e2e.js "<账号>" "<密码>"
 */
const fs = require('fs');
const srv = fs.readFileSync('server.js', 'utf8');
function grab(name, src) {
  const i = src.indexOf('function ' + name + '(');
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1);
}
const names = ['normAbs', 'encPath', 'pathPrefix', 'splitUrl', 'davUrlAbs', 'hrefToAbsPath'];
const ctx = new Function(names.map((n) => grab(n, srv)).join('\n')
  + '\nreturn { ' + names.join(', ') + ' };')();

const USER = process.argv[2], PASS = process.argv[3];
const CFG = { url: 'http://192.168.1.100:19798/dav', user: USER, pass: PASS };
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

async function pf(absPath, depth = 1) {
  const url = ctx.davUrlAbs(CFG, absPath, true);
  const r = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: AUTH, Depth: String(depth), 'Content-Type': 'application/xml' },
  });
  return { code: r.status, body: await r.text(), url };
}
const hrefs = (xml) => [...xml.matchAll(/<D:href>([^<]*)<\/D:href>|<d:href>([^<]*)<\/d:href>/g)]
  .map((m) => ctx.hrefToAbsPath(m[1] || m[2]));
const isDir = (xml) => null; // 目录判定按 href 尾部是否出现在 collection 段里，简化处理

(async () => {
  console.log('配置地址 :', CFG.url);
  console.log('账号     :', USER);

  // ① 登录：探根（App 的 #cfLogin 就是这一发）
  const root = await pf('/dav');
  console.log('\n① 登录探根  →', root.code, root.code === 207 ? '✅ 成功' : '❌ 失败');
  console.log('   实际打的地址 :', root.url);
  if (root.code !== 207) { console.log('   返回:', root.body.slice(0, 300)); return; }

  // ② 根目录有哪些文件夹
  const names0 = [...new Set(hrefs(root.body))].filter((h) => h.replace(/\/$/, '') !== '/dav');
  console.log('\n② 根目录', names0.length, '项 :');
  names0.slice(0, 12).forEach((h) => console.log('   ', h));

  // ③ 挑一个已知有视频的目录深挖
  for (const dir of ['/dav/电影电视', '/dav/示例目录']) {
    const r = await pf(dir);
    const kids = [...new Set(hrefs(r.body))].filter((h) => h.replace(/\/$/, '') !== dir);
    console.log(`\n③ ${dir}  → ${r.code}，${kids.length} 项`);
    kids.slice(0, 4).forEach((h) => console.log('   ', h));
  }

  // ④ 真取一个视频的头部（验证能播）
  const mov = '/dav/示例目录/Screenrecorder-2026-08-18-23-23-28-455.mp4';
  const url = ctx.davUrlAbs(CFG, mov, false);
  const r = await fetch(url, { headers: { Authorization: AUTH, Range: 'bytes=0-1023' } });
  console.log('\n④ 取流 Range  →', r.status, r.status === 206 ? '✅ 可拖动播放' : '');
  console.log('   地址 :', url);
  console.log('   Content-Range :', r.headers.get('content-range'));
})();
