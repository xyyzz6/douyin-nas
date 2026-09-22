/* ============================================================================
 *  WebDAV 子路径挂载 —— 两个后端「URL 拼接规则」对拍脚本
 *
 *  背景：APK（DavClient.java）和电脑版（server.js）各有一套 URL 拼接实现，
 *  两边必须对同一个输入产出同一个地址。曾经两边同时错、而且错在**相反方向**：
 *    · server.js 的 davUrlAbs() 只取 origin，把地址里的 `/dav` 整个丢了 → 405
 *    · DavClient.absUrl() 无条件 `base + path`，path 本来带着 `/dav` → `/dav/dav` → 404
 *  这个脚本把两边的实现逐字搬过来跑同一批用例，任何一边改动后跑一遍就知道有没有跑偏。
 *
 *  跑法： node _tmp/urlparity.js
 *  口径：目录走 PROPFIND（比「请求行里的 path」），文件走流（比完整 URL）。
 * ==========================================================================*/

// ───────────────────────── server.js 侧（照抄源码） ─────────────────────────
function srvEncPath(p) {
  const s = String(p == null ? '' : p);
  if (s === '' || s === '/') return '/';
  const dir = s.endsWith('/');
  const out = [];
  for (const seg of s.split('/')) { if (!seg) continue; out.push(encodeURIComponent(seg).replace(/%2F/gi, '/')); }
  if (!out.length) return '/';
  return '/' + out.join('/') + (dir ? '/' : '');
}
function srvNormAbs(p) {
  const s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  const out = [];
  for (const seg of (s.startsWith('/') ? s : '/' + s).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}
function srvPathPrefix(p) { let s = String(p == null ? '' : p); while (s.endsWith('/')) s = s.slice(0, -1); return s; }
function srvSplitUrl(url) {
  const raw = String(url || '').trim();
  try { const u = new URL(raw); return { origin: u.origin, urlPath: srvPathPrefix(u.pathname) }; }
  catch (_) { return { origin: raw.replace(/\/+$/, ''), urlPath: '' }; }
}
function davUrlAbs(cfg, absPath, isDir) {
  const { origin, urlPath } = srvSplitUrl(cfg.url);
  let p = srvNormAbs(absPath);
  if (urlPath && p !== urlPath && !p.startsWith(urlPath + '/')) p = srvNormAbs(urlPath + p);
  const needsSlash = isDir && p !== urlPath;
  let out = origin + srvEncPath(p);
  if (needsSlash && !out.endsWith('/')) out += '/';
  return out;
}

// ───────────────────────── DavClient.java 侧（照抄源码） ─────────────────────
function javaPathOf(url) {           // Java 是 new URL(u).getPath()；JS 等价物是 .pathname
  try { let p = new URL(url).pathname; if (p == null) return ''; while (p.endsWith('/')) p = p.substring(0, p.length - 1); return p; }
  catch (e) { return ''; }
}
function makeDavClient(url) {
  let b = String(url == null ? '' : url).trim();
  while (b.endsWith('/')) b = b.substring(0, b.length - 1);   // 先砍尾斜杠
  return { base: b, basePrefix: javaPathOf(b) };              // 再取前缀
}
function relOf(c, path) {
  let p = path == null ? '' : String(path).trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (c.basePrefix !== '') {
    if (p === c.basePrefix || p === c.basePrefix + '/') return '/';
    if (p.startsWith(c.basePrefix + '/')) return p.substring(c.basePrefix.length);
  }
  return p;
}
function javaAbsUrl(c, path) {
  const rel = relOf(c, path);
  if (rel === '/' && c.basePrefix !== '') return c.base;      // 别落成 …/dav/（301 陷阱）
  return c.base + srvEncPath(rel);
}
function propfindPath(c, path) {
  const rel = relOf(c, path);
  if (rel === '/') return c.basePrefix === '' ? '/' : c.basePrefix;
  if (rel === '') return c.basePrefix + '/';
  const p = c.basePrefix + srvEncPath(rel);      // 前缀要重新补回请求行
  return p.endsWith('/') ? p : p + '/';          // PROPFIND 打的永远是目录
}

// ──────────────────────────────── 用例集 ────────────────────────────────────
const U = 'http://192.168.1.100:19798/dav';
const NC = 'http://nas.example.com/remote.php/dav/files/user';
const cases = [
  ['CD2 子路径',        U,          '/dav/115open',                              false],
  ['CD2 子路径(目录)',  U,          '/dav/115open',                              true ],
  ['CD2 手填无前缀',    U,          '/115open',                                  false],
  ['CD2 服务根',        U,          '/dav',                                      false],
  ['CD2 服务根(空)',    U,          '/',                                         false],
  ['CD2 服务根(目录)',  U,          '/dav',                                      true ],
  ['CD2 地址尾斜杠',    U + '/',    '/dav/115open',                              false],
  ['群晖根挂载',        'http://192.168.1.100:5005', '/video/2024',               false],
  ['群晖目录',          'http://192.168.1.100:5005', '/video/2024',               true ],
  ['群晖根(空)',        'http://192.168.1.100:5005', '/',                         false],
  ['Nextcloud',         NC,         '/remote.php/dav/files/user/Photos/a.mp4',   false],
  ['Nextcloud 无前缀',  NC,         '/Photos/a.mp4',                             false],
  ['Nextcloud 目录',    NC,         '/remote.php/dav/files/user/Photos',         true ],
  ['Alist',             'http://192.168.1.100:5244/dav', '/dav/115/电影',         false],
  ['前缀同名目录',      'http://x:1/dav', '/davos/x',                            false],
  ['中文+空格',         U,          '/dav/我的 视频/a.mp4',                      false],
  ['深层中文目录',      U,          '/dav/115open/电影/2024年/a.mp4',            false],
];

let bad = 0;
for (const [name, url, p, isDir] of cases) {
  const c = makeDavClient(url);
  const java = isDir ? propfindPath(c, p) : javaAbsUrl(c, p);
  const srvFull = davUrlAbs({ url }, p, isDir);
  // 目录（PROPFIND）比「请求行 path」；文件（流）比完整 URL
  const srv = isDir ? new URL(srvFull).pathname : srvFull;
  const ok = srv === java;
  if (!ok) bad++;
  console.log((ok ? '✅' : '❌') + ' ' + name);
  if (!ok) {
    console.log('     server.js : ' + srv);
    console.log('     java      : ' + java);
  }
}
console.log(bad ? `\n❌ ${bad}/${cases.length} 不一致` : `\n✅ ${cases.length}/${cases.length} 两边完全一致`);

// ───────────────── 关键回归：修复前踩过的三个坑，确认都不再复现 ────────────────
console.log('\n──────── 修复前后对比 ────────');
const cfg = { url: U };
const href = '/dav/115open/%E7%94%B5%E5%BD%B1/a.mp4';   // CD2 PROPFIND 返回的 href，本来就带 /dav
const abs = srvNormAbs(decodeURIComponent(href));
const srvNow = davUrlAbs(cfg, abs, false);
const javaNow = javaAbsUrl(makeDavClient(U), abs);
console.log('PROPFIND href      :', href);
console.log('归一后 absPath     :', abs);
console.log('server.js 现在     :', srvNow);
console.log('java      现在     :', javaNow);
console.log('修复前(丢 /dav)    :', srvSplitUrl(U).origin + srvEncPath(abs), '  → 405');
console.log('修复前(双 /dav)    :', U + srvEncPath(abs), '  → 404');
console.log('期望               :', 'http://192.168.1.100:19798/dav/115open/%E7%94%B5%E5%BD%B1/a.mp4');
