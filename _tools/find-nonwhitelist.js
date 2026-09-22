/**
 * 在 NAS 上 BFS 找「非白名单」的视频文件（avi / wmv / mkv / flv / ts / ...）。
 *
 * 目的：给「片库只列能直接播的格式」这条改动做**同目录 A/B 对照**。
 * 光看片库里没有 avi 是不够的 —— 如果那些目录本来就没有 avi，测了等于没测。
 * 得先找到一个**确实含 avi/wmv/mkv** 的目录，再拿它去比：
 *   · 原始 PROPFIND  → 能数出这些文件
 *   · /api/browse    → 应该一个都不列（片库白名单）
 *
 * ⚠️ CD2 的 WebDAV **不支持 Depth: 3**（返回空），所以只能一层层 BFS。
 * ⚠️ 只读，不改任何东西。NAS 连接时好时坏，失败就跳过。
 *
 * 用法：node _tools/find-nonwhitelist.js [起始路径] [最大深度] [最大请求数]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ⚠️ 凭据从 data/config.json 读，**别硬编码进源码**（这是要进仓库的文件）。 */
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const ORIGIN = new URL(cfg.url).origin;
const AUTH = cfg.user + ':' + cfg.pass;
const OK = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];
/* 全部**认的**视频扩展名（对应两后端的 ALL_EXTS）。
   ⚠️ 必须先按这个过滤再看白名单 —— 否则 apk / jpg / zip 这些非视频文件
   也会被当成「非白名单视频」报出来（第一版就犯了这个错）。 */
const ALL = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'flv', 'wmv',
  'ts', 'mpg', 'mpeg', '3gp', 'rmvb'];
const BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>';

const start = process.argv[2] || '/dav/云下载';
const maxDepth = Number(process.argv[3] || 3);
const budget = Number(process.argv[4] || 28);

function pf(path) {
  /* ⚠️ 路径里有中文，curl **不会**自动做百分号编码 —— 不编码的话
     CD2 直接返回空（表现为「无响应」），会让人误以为目录是空的。 */
  const enc = path.split('/').map(encodeURIComponent).join('/');
  try {
    return execFileSync('curl', ['-s', '--max-time', '40', '-u', AUTH,
      '-X', 'PROPFIND', '-H', 'Depth: 1', '--data', BODY, ORIGIN + enc],
      { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) { return ''; }
}

const entries = (xml) =>
  [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => decodeURIComponent(m[1]));

const q = [[start, 1]];
const seen = new Set();
const hits = [];
let reqs = 0;

while (q.length && reqs < budget) {
  const [p, d] = q.shift();
  if (seen.has(p)) continue;
  seen.add(p);
  const xml = pf(p);
  reqs++;
  if (!xml) { console.log('  (无响应，跳过) ' + p); continue; }
  for (const h of entries(xml)) {
    if (h.endsWith('/')) { if (d < maxDepth && !seen.has(h)) q.push([h, d + 1]); continue; }
    const m = h.match(/\.([A-Za-z0-9]+)$/);
    if (!m) continue;
    const e = m[1].toLowerCase();
    if (!ALL.includes(e)) continue;          // 不是视频文件，不关心
    if (!OK.includes(e)) hits.push({ e, p: h });
  }
}

console.log(`发出 PROPFIND ${reqs} 次，扫过 ${seen.size} 个目录（起始 ${start}，最大深度 ${maxDepth}）`);
if (!hits.length) {
  console.log('没找到非白名单视频文件 —— 这批目录做不了 A/B 对照。');
} else {
  const byExt = {};
  for (const h of hits) byExt[h.e] = (byExt[h.e] || 0) + 1;
  console.log('找到非白名单视频:', JSON.stringify(byExt), '共', hits.length);
  const dirs = [...new Set(hits.map((h) => h.p.slice(0, h.p.lastIndexOf('/'))))];
  console.log('所在目录（拿来跑 /api/browse 做对照）:');
  dirs.slice(0, 8).forEach((d) => console.log('   ' + d));
}
